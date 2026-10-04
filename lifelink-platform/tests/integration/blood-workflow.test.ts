import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const testDatabaseUrl = process.env.LIFELINK_TEST_DATABASE_URL;

test("blood workflow authorization, retry, expiry, inventory safety, and fulfilment", { skip: !testDatabaseUrl }, async () => {
  process.env.DATABASE_URL = testDatabaseUrl!;
  const { database, reserveBloodUnits } = await import("../../packages/database/src/index");
  const { BloodComponent, BloodGroup, InstitutionStatus, InstitutionType, RequestPriority, RequestStatus, RequestType, UserRole } = await import("@prisma/client");
  const { reviewBloodRequest, respondToBloodOffer, evaluateBloodOffer, dispatchBloodRequest, receiveBloodRequest, expireBloodReservations } = await import("../../apps/api/src/modules/requests/blood-workflow.service");
  const { startBloodMatchingWorkflow } = await import("../../apps/api/src/modules/requests/matching.service");

  const suffix = randomUUID();
  const createdUserIds: string[] = [];
  const institutionIds: string[] = [];
  const requestIds: string[] = [];
  const inventoryIds: string[] = [];
  try {
    const hospital = await database.institution.create({ data: { name: `Test Hospital ${suffix}`, type: InstitutionType.HOSPITAL, status: InstitutionStatus.ACTIVE, address: "Test Ward", latitude: 10, longitude: 77 } });
    const bloodBank = await database.institution.create({ data: { name: `Test Blood Bank ${suffix}`, type: InstitutionType.BLOOD_BANK, status: InstitutionStatus.ACTIVE, address: "Test Centre", latitude: 10, longitude: 77 } });
    const remoteBank = await database.institution.create({ data: { name: `Remote Blood Bank ${suffix}`, type: InstitutionType.BLOOD_BANK, status: InstitutionStatus.ACTIVE, address: "Remote Centre", latitude: 10.75, longitude: 77 } });
    institutionIds.push(hospital.id, bloodBank.id, remoteBank.id);
    const requester = await database.user.create({ data: { name: "Workflow Requester", email: `requester-${suffix}@example.test`, passwordHash: "not-used-by-test", role: UserRole.HOSPITAL_USER, institutionId: hospital.id } });
    const provider = await database.user.create({ data: { name: "Workflow Provider", email: `provider-${suffix}@example.test`, passwordHash: "not-used-by-test", role: UserRole.BLOOD_BANK_USER, institutionId: bloodBank.id } });
    const admin = await database.user.create({ data: { name: "Workflow Admin", email: `admin-${suffix}@example.test`, passwordHash: "not-used-by-test", role: UserRole.ADMINISTRATOR } });
    createdUserIds.push(requester.id, provider.id, admin.id);
    const requesterActor = { userId: requester.id, role: "HOSPITAL_USER" as const, institutionId: hospital.id };
    const providerActor = { userId: provider.id, role: "BLOOD_BANK_USER" as const, institutionId: bloodBank.id };
    const adminActor = { userId: admin.id, role: "ADMINISTRATOR" as const };
    const stock = await database.bloodInventory.create({ data: { institutionId: bloodBank.id, bloodGroup: BloodGroup.O_POSITIVE, component: BloodComponent.RED_BLOOD_CELLS, unitsAvailable: 10, expiryDate: new Date(Date.now() + 7 * 86_400_000) } });
    const remoteStock = await database.bloodInventory.create({ data: { institutionId: remoteBank.id, bloodGroup: BloodGroup.AB_NEGATIVE, component: BloodComponent.RED_BLOOD_CELLS, unitsAvailable: 8, expiryDate: new Date(Date.now() + 7 * 86_400_000) } });
    inventoryIds.push(stock.id, remoteStock.id);

    const createRequest = (group: typeof BloodGroup[keyof typeof BloodGroup], quantity: number, radiusKm = 50) => database.request.create({ data: { requestType: RequestType.BLOOD, bloodGroup: group, component: BloodComponent.RED_BLOOD_CELLS, quantity, priority: RequestPriority.NORMAL, location: "Test Hospital", latitude: 10, longitude: 77, radiusKm, contactNumber: "+10000000000", createdById: requester.id } });
    const request = await createRequest(BloodGroup.O_POSITIVE, 3);
    requestIds.push(request.id);
    await reviewBloodRequest(request.id, adminActor);
    const candidates = await startBloodMatchingWorkflow(request.id, requester.id);
    assert.equal(candidates.matching.status, "MATCHES_FOUND");
    const matchId = candidates.matching.candidates[0]?.matchId;
    assert.ok(matchId);

    await assert.rejects(respondToBloodOffer(request.id, matchId, "ACCEPT", { userId: "outsider", role: "BLOOD_BANK_USER", institutionId: remoteBank.id }), (error: any) => error.status === 403);
    await assert.rejects(dispatchBloodRequest(request.id, providerActor), (error: any) => error.status === 409);
    await respondToBloodOffer(request.id, matchId, "ACCEPT", providerActor);
    await evaluateBloodOffer(request.id, matchId, "ACCEPT", requesterActor);
    let inventory = await database.bloodInventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [7, 3]);
    await assert.rejects(database.$transaction((tx) => reserveBloodUnits(tx, stock.id, 8)), /unavailable/);
    inventory = await database.bloodInventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [7, 3]);
    await dispatchBloodRequest(request.id, providerActor);
    const fulfilled = await receiveBloodRequest(request.id, requesterActor);
    assert.equal(fulfilled.status, RequestStatus.FULFILLED);
    inventory = await database.bloodInventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [7, 0]);

    const noMatchRequest = await createRequest(BloodGroup.AB_NEGATIVE, 2, 50);
    requestIds.push(noMatchRequest.id);
    await reviewBloodRequest(noMatchRequest.id, adminActor);
    const noMatch = await startBloodMatchingWorkflow(noMatchRequest.id, requester.id);
    assert.equal(noMatch.matching.status, "NO_MATCH");
    assert.equal(noMatch.request?.status, RequestStatus.REOPENED);
    const retry = await startBloodMatchingWorkflow(noMatchRequest.id, requester.id, 100);
    assert.equal(retry.matching.status, "MATCHES_FOUND");
    assert.equal(retry.request?.status, RequestStatus.INSTITUTIONS_NOTIFIED);

    const expiringRequest = await createRequest(BloodGroup.O_POSITIVE, 2);
    requestIds.push(expiringRequest.id);
    await reviewBloodRequest(expiringRequest.id, adminActor);
    const expiringCandidates = await startBloodMatchingWorkflow(expiringRequest.id, requester.id);
    const expiringMatchId = expiringCandidates.matching.candidates[0]?.matchId;
    assert.ok(expiringMatchId);
    await respondToBloodOffer(expiringRequest.id, expiringMatchId, "ACCEPT", providerActor);
    await evaluateBloodOffer(expiringRequest.id, expiringMatchId, "ACCEPT", requesterActor);
    await database.match.update({ where: { id: expiringMatchId }, data: { reservationExpiresAt: new Date(Date.now() - 1_000) } });
    const expired = await expireBloodReservations(new Date());
    assert.ok(expired.expiredCount >= 1);
    const expiredRequest = await database.request.findUniqueOrThrow({ where: { id: expiringRequest.id } });
    assert.equal(expiredRequest.status, RequestStatus.EXPIRED);
    inventory = await database.bloodInventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [7, 0]);
  } finally {
    const matches = requestIds.length ? await database.match.findMany({ where: { requestId: { in: requestIds } }, select: { id: true } }) : [];
    const workflowEvents = requestIds.length ? await database.workflowEvent.findMany({ where: { requestId: { in: requestIds } }, select: { id: true } }) : [];
    const entityIds = [...requestIds, ...inventoryIds, ...matches.map((item) => item.id)];
    const notificationScopes = [...(createdUserIds.length ? [{ userId: { in: createdUserIds } }] : []), ...(workflowEvents.length ? [{ eventId: { in: workflowEvents.map((event) => event.id) } }] : [])];
    if (notificationScopes.length) await database.notification.deleteMany({ where: { OR: notificationScopes } });
    if (requestIds.length) await database.workflowEvent.deleteMany({ where: { requestId: { in: requestIds } } });
    const auditScopes = [...(createdUserIds.length ? [{ actorId: { in: createdUserIds } }] : []), ...(entityIds.length ? [{ entityId: { in: entityIds } }] : [])];
    if (auditScopes.length) await database.auditLog.deleteMany({ where: { OR: auditScopes } });
    if (requestIds.length) await database.request.deleteMany({ where: { id: { in: requestIds } } });
    if (inventoryIds.length) await database.bloodInventory.deleteMany({ where: { id: { in: inventoryIds } } });
    if (createdUserIds.length) await database.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (institutionIds.length) await database.institution.deleteMany({ where: { id: { in: institutionIds } } });
    await database.$disconnect();
  }
});

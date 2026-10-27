import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { cleanupBloodRecords, createdRecords, rejectsWith, skipReason, useTestDatabase } from "./support";

// FR coverage: LL-FR-BREQ, LL-FR-INV, LL-FR-AUTH against a real PostgreSQL database.

type DatabaseModule = typeof import("../../packages/database/src/index");
type WorkflowModule = typeof import("../../apps/api/src/modules/requests/blood-workflow.service");
type MatchingModule = typeof import("../../apps/api/src/modules/requests/matching.service");

// A remote location so stock created by other suites never falls inside this suite's search radius.
const ORIGIN = { latitude: -45.03, longitude: 168.66 };
const KM_PER_DEGREE = 111;

describe("blood workflow edge cases (PostgreSQL)", { skip: skipReason }, () => {
  let db: DatabaseModule;
  let workflow: WorkflowModule;
  let matching: MatchingModule;
  const created = createdRecords();
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    useTestDatabase();
    db = await import("../../packages/database/src/index");
    workflow = await import("../../apps/api/src/modules/requests/blood-workflow.service");
    matching = await import("../../apps/api/src/modules/requests/matching.service");
  });

  after(async () => {
    if (!db) return;
    await cleanupBloodRecords(db.database, created);
    await db.database.$disconnect();
  });

  async function institution(type: "HOSPITAL" | "BLOOD_BANK", name: string, options: { offsetKm?: number; status?: "ACTIVE" | "INACTIVE" } = {}) {
    const record = await db.database.institution.create({ data: {
      name: `${name} ${suffix}`, type, status: options.status ?? "ACTIVE", address: "Integration test site",
      latitude: ORIGIN.latitude + (options.offsetKm ?? 0) / KM_PER_DEGREE, longitude: ORIGIN.longitude,
    } });
    created.institutions.push(record.id);
    return record;
  }

  async function stock(institutionId: string, data: { bloodGroup: string; component: string; unitsAvailable: number; expiryDate?: Date }) {
    const record = await db.database.bloodInventory.create({ data: {
      institutionId, bloodGroup: data.bloodGroup as never, component: data.component as never, unitsAvailable: data.unitsAvailable,
      expiryDate: data.expiryDate ?? new Date(Date.now() + 10 * 86_400_000),
    } });
    created.inventory.push(record.id);
    return record;
  }

  async function bloodRequest(creatorInstitutionId: string, data: { bloodGroup: string; component: string; quantity: number }) {
    const record = await db.database.request.create({ data: {
      requestType: "BLOOD", bloodGroup: data.bloodGroup as never, component: data.component as never, quantity: data.quantity,
      priority: "URGENT", status: "UNDER_REVIEW", location: "Integration test ward", ...ORIGIN, radiusKm: 30,
      contactNumber: "+911234567890", createdByInstitutionId: creatorInstitutionId,
    } });
    created.requests.push(record.id);
    return record;
  }

  const hospitalActor = (institutionId: string) => ({ role: "HOSPITAL_USER" as const, principalType: "INSTITUTION" as const, institutionId, capabilities: { blood: true, organ: false } });
  const bankActor = (institutionId: string) => ({ role: "BLOOD_BANK_USER" as const, principalType: "INSTITUTION" as const, institutionId, capabilities: { blood: true, organ: false } });

  async function matchFor(requestId: string, inventoryId: string) {
    const outcome = await matching.startBloodMatchingWorkflow(requestId);
    const candidate = outcome.matching.candidates.find((item) => item.inventoryId === inventoryId);
    assert.ok(candidate?.matchId, "expected the test stock among the candidates");
    return candidate.matchId;
  }

  test("IT-BLD-02 matching ignores expired, stale, insufficient, out-of-radius, inactive and mismatched stock", async () => {
    const bank = await institution("BLOOD_BANK", "Filter bank");
    const inactiveBank = await institution("BLOOD_BANK", "Inactive bank", { status: "INACTIVE" });
    const farBank = await institution("BLOOD_BANK", "Far bank", { offsetKm: 80 });
    const hospital = await institution("HOSPITAL", "Filter hospital");
    const decoys = [
      await stock(bank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5, expiryDate: new Date(Date.now() - 86_400_000) }),
      await stock(bank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 2 }),
      await stock(bank.id, { bloodGroup: "O_POSITIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5 }),
      await stock(bank.id, { bloodGroup: "O_NEGATIVE", component: "PLATELETS", unitsAvailable: 5 }),
      await stock(inactiveBank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5 }),
      await stock(farBank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5 }),
    ];
    const stale = await stock(bank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5 });
    await db.database.$executeRaw`UPDATE "BloodInventory" SET "lastUpdated" = NOW() - INTERVAL '2 days' WHERE "id" = ${stale.id}::uuid`;

    const request = await bloodRequest(hospital.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", quantity: 3 });
    const first = await matching.startBloodMatchingWorkflow(request.id);
    assert.equal(first.matching.status, "NO_MATCH", `decoys ${decoys.length + 1} must all be excluded`);
    assert.equal(first.request?.status, "REOPENED");

    const valid = await stock(bank.id, { bloodGroup: "O_NEGATIVE", component: "CRYOPRECIPITATE", unitsAvailable: 5 });
    const retry = await matching.startBloodMatchingWorkflow(request.id);
    assert.equal(retry.matching.status, "MATCHES_FOUND");
    assert.deepEqual(retry.matching.candidates.map((candidate) => candidate.inventoryId), [valid.id]);
    assert.equal(retry.request?.status, "INSTITUTIONS_NOTIFIED");
  });

  test("IT-BLD-03 two requesters racing for the same units: exactly one reservation succeeds and the loser is rolled back", async () => {
    const bank = await institution("BLOOD_BANK", "Race bank");
    const hospitalA = await institution("HOSPITAL", "Race hospital A");
    const hospitalB = await institution("HOSPITAL", "Race hospital B");
    const units = await stock(bank.id, { bloodGroup: "B_NEGATIVE", component: "PLASMA", unitsAvailable: 10 });
    const requestA = await bloodRequest(hospitalA.id, { bloodGroup: "B_NEGATIVE", component: "PLASMA", quantity: 6 });
    const requestB = await bloodRequest(hospitalB.id, { bloodGroup: "B_NEGATIVE", component: "PLASMA", quantity: 6 });
    const matchA = await matchFor(requestA.id, units.id);
    const matchB = await matchFor(requestB.id, units.id);
    await workflow.respondToBloodOffer(requestA.id, matchA, "ACCEPT", bankActor(bank.id));
    await workflow.respondToBloodOffer(requestB.id, matchB, "ACCEPT", bankActor(bank.id));

    const results = await Promise.allSettled([
      workflow.evaluateBloodOffer(requestA.id, matchA, "ACCEPT", hospitalActor(hospitalA.id)),
      workflow.evaluateBloodOffer(requestB.id, matchB, "ACCEPT", hospitalActor(hospitalB.id)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const loser = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(loser && rejectsWith(409)(loser.reason));

    const inventory = await db.database.bloodInventory.findUniqueOrThrow({ where: { id: units.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [4, 6], "units are never double-reserved");
    const statuses = (await db.database.request.findMany({ where: { id: { in: [requestA.id, requestB.id] } }, select: { status: true } })).map(({ status }) => status).sort();
    assert.deepEqual(statuses, ["OFFERS_RECEIVED", "RESERVED"], "the losing evaluation left no partial state behind");
  });

  test("IT-BLD-04 a provider declining the only offer reopens the request, and a new search can find it again", async () => {
    const bank = await institution("BLOOD_BANK", "Decline bank");
    const hospital = await institution("HOSPITAL", "Decline hospital");
    const units = await stock(bank.id, { bloodGroup: "A_NEGATIVE", component: "WHOLE_BLOOD", unitsAvailable: 4 });
    const request = await bloodRequest(hospital.id, { bloodGroup: "A_NEGATIVE", component: "WHOLE_BLOOD", quantity: 1 });
    const match = await matchFor(request.id, units.id);
    await assert.rejects(workflow.evaluateBloodOffer(request.id, match, "ACCEPT", hospitalActor(hospital.id)), rejectsWith(409), "a requester cannot accept an offer the provider has not confirmed");
    await workflow.respondToBloodOffer(request.id, match, "REJECT", bankActor(bank.id));
    assert.equal((await db.database.request.findUniqueOrThrow({ where: { id: request.id } })).status, "REOPENED");
    await assert.rejects(workflow.respondToBloodOffer(request.id, match, "ACCEPT", bankActor(bank.id)), rejectsWith(409), "a declined offer cannot be revived");
    const retry = await matching.startBloodMatchingWorkflow(request.id);
    assert.equal(retry.request?.status, "INSTITUTIONS_NOTIFIED");
  });

  test("IT-BLD-05 only the right parties can evaluate, fulfil or cancel, and cancelling releases the reservation", async () => {
    const bank = await institution("BLOOD_BANK", "Lifecycle bank");
    const otherBank = await institution("BLOOD_BANK", "Other bank");
    const hospital = await institution("HOSPITAL", "Lifecycle hospital");
    const otherHospital = await institution("HOSPITAL", "Other hospital");
    const units = await stock(bank.id, { bloodGroup: "AB_POSITIVE", component: "RED_BLOOD_CELLS", unitsAvailable: 5 });
    const request = await bloodRequest(hospital.id, { bloodGroup: "AB_POSITIVE", component: "RED_BLOOD_CELLS", quantity: 2 });
    const match = await matchFor(request.id, units.id);

    await assert.rejects(workflow.respondToBloodOffer(request.id, match, "ACCEPT", bankActor(otherBank.id)), rejectsWith(403));
    await workflow.respondToBloodOffer(request.id, match, "ACCEPT", bankActor(bank.id));
    await assert.rejects(workflow.evaluateBloodOffer(request.id, match, "ACCEPT", hospitalActor(otherHospital.id)), rejectsWith(403));
    await assert.rejects(workflow.fulfillBloodRequest(request.id, bankActor(bank.id)), rejectsWith(409), "nothing can be fulfilled before a reservation");
    await workflow.evaluateBloodOffer(request.id, match, "ACCEPT", hospitalActor(hospital.id));

    let inventory = await db.database.bloodInventory.findUniqueOrThrow({ where: { id: units.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [3, 2]);
    await assert.rejects(workflow.fulfillBloodRequest(request.id, bankActor(otherBank.id)), rejectsWith(403));
    await assert.rejects(workflow.fulfillBloodRequest(request.id, hospitalActor(hospital.id)), rejectsWith(403), "the requester cannot mark its own request fulfilled");

    const cancelled = await workflow.cancelBloodRequest(request.id, hospitalActor(hospital.id));
    assert.equal(cancelled.status, "CANCELLED");
    inventory = await db.database.bloodInventory.findUniqueOrThrow({ where: { id: units.id } });
    assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [5, 0], "cancelling returns the reserved units");
    await assert.rejects(workflow.cancelBloodRequest(request.id, hospitalActor(hospital.id)), rejectsWith(409));
    await assert.rejects(workflow.fulfillBloodRequest(request.id, bankActor(bank.id)), rejectsWith(409));
  });

  test("IT-BLD-06 restocked inventory becomes searchable again", async () => {
    const bank = await institution("BLOOD_BANK", "Restock bank");
    const hospital = await institution("HOSPITAL", "Restock hospital");
    const units = await stock(bank.id, { bloodGroup: "B_POSITIVE", component: "WHOLE_BLOOD", unitsAvailable: 2 });
    const first = await bloodRequest(hospital.id, { bloodGroup: "B_POSITIVE", component: "WHOLE_BLOOD", quantity: 2 });
    const match = await matchFor(first.id, units.id);
    await workflow.respondToBloodOffer(first.id, match, "ACCEPT", bankActor(bank.id));
    await workflow.evaluateBloodOffer(first.id, match, "ACCEPT", hospitalActor(hospital.id));
    await workflow.fulfillBloodRequest(first.id, bankActor(bank.id));
    assert.equal((await db.database.bloodInventory.findUniqueOrThrow({ where: { id: units.id } })).status, "UNAVAILABLE");

    const restocked = await db.updateBloodInventoryForInstitution(units.id, bank.id, { unitsAvailable: 6 });
    assert.equal(restocked.status, "AVAILABLE", "editing the units recomputes the status");
    const second = await bloodRequest(hospital.id, { bloodGroup: "B_POSITIVE", component: "WHOLE_BLOOD", quantity: 1 });
    const outcome = await matching.startBloodMatchingWorkflow(second.id);
    assert.equal(outcome.matching.status, "MATCHES_FOUND");
    assert.deepEqual(outcome.matching.candidates.map((candidate) => candidate.inventoryId), [units.id]);
  });

  test("IT-BLD-07 restocking units that are already past expiry keeps them out of matching", async () => {
    const bank = await institution("BLOOD_BANK", "Expired restock bank");
    const hospital = await institution("HOSPITAL", "Expired restock hospital");
    const units = await stock(bank.id, { bloodGroup: "A_POSITIVE", component: "PLATELETS", unitsAvailable: 0 });
    const restocked = await db.updateBloodInventoryForInstitution(units.id, bank.id, { unitsAvailable: 5, expiryDate: new Date(Date.now() - 3_600_000) });
    assert.equal(restocked.status, "EXPIRED");
    const request = await bloodRequest(hospital.id, { bloodGroup: "A_POSITIVE", component: "PLATELETS", quantity: 1 });
    assert.equal((await matching.startBloodMatchingWorkflow(request.id)).matching.status, "NO_MATCH");
  });
});

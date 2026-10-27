import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { rejectsWith, skipReason, useTestDatabase } from "./support";
import type { AuthContext } from "../../apps/api/src/middleware/auth";

// FR coverage: LL-FR-ORG (consent, authorization, matching, offers, expiry) and LL-FR-AUTH (institution scope).

type DatabaseModule = typeof import("../../packages/database/src/index");
type OrganModule = typeof import("../../apps/api/src/modules/organ-coordination/service");

// A remote location so recipients created by other suites never fall inside this suite's radius.
const CENTRE = { latitude: -40.0, longitude: 175.0 };

describe("organ coordination edge cases (PostgreSQL)", { skip: skipReason }, () => {
  let db: DatabaseModule;
  let organ: OrganModule;
  const suffix = randomUUID().slice(0, 8);
  const ids = { institutions: [] as string[], users: [] as string[], donors: [] as string[], recipients: [] as string[] };
  let sequence = 0;

  before(async () => {
    useTestDatabase();
    db = await import("../../packages/database/src/index");
    organ = await import("../../apps/api/src/modules/organ-coordination/service");
  });

  after(async () => {
    if (!db) return;
    const database = db.database;
    const organIds = (await database.organRecord.findMany({ where: { donorId: { in: ids.donors } }, select: { id: true } })).map(({ id }) => id);
    const offerIds = (await database.organOffer.findMany({ where: { organId: { in: organIds } }, select: { id: true } })).map(({ id }) => id);
    const events = (await database.workflowEvent.findMany({
      where: { OR: [{ actorInstitutionId: { in: ids.institutions } }, { actorId: { in: ids.users } }, ...organIds.map((organId) => ({ payload: { path: ["organId"], equals: organId } }))] },
      select: { id: true },
    })).map(({ id }) => id);
    await database.notification.deleteMany({ where: { OR: [{ eventId: { in: events } }, { userId: { in: ids.users } }, { institutionId: { in: ids.institutions } }] } });
    await database.workflowEvent.deleteMany({ where: { id: { in: events } } });
    await database.auditLog.deleteMany({ where: { OR: [{ actorInstitutionId: { in: ids.institutions } }, { actorId: { in: ids.users } }, { entityId: { in: [...organIds, ...offerIds, ...ids.donors, ...ids.recipients] } }] } });
    await database.organOffer.deleteMany({ where: { id: { in: offerIds } } });
    await database.organProcurement.deleteMany({ where: { organId: { in: organIds } } });
    await database.organRecord.deleteMany({ where: { id: { in: organIds } } });
    await database.organRecipient.deleteMany({ where: { id: { in: ids.recipients } } });
    await database.organDonor.deleteMany({ where: { id: { in: ids.donors } } });
    await database.user.deleteMany({ where: { id: { in: ids.users } } });
    await database.institution.deleteMany({ where: { id: { in: ids.institutions } } });
    await database.$disconnect();
  });

  const centreActor = (institutionId: string): AuthContext => ({ role: "ORGAN_CENTRE_USER", principalType: "INSTITUTION", institutionId });
  const personal = (userId: string): AuthContext => ({ userId, role: "USER", principalType: "USER" });

  async function centre(name: string, offsetKm = 0) {
    const record = await db.database.institution.create({ data: {
      name: `${name} ${suffix}`, type: "ORGAN_CENTRE", status: "ACTIVE", address: "Integration test centre",
      latitude: CENTRE.latitude - offsetKm / 111, longitude: CENTRE.longitude,
    } });
    ids.institutions.push(record.id);
    return record;
  }

  async function person(name: string) {
    const record = await db.database.user.create({ data: { name, email: `${name.toLowerCase().replaceAll(" ", ".")}-${suffix}@example.test`, phone: "+911234567890", passwordHash: "not-used", role: "USER" } });
    ids.users.push(record.id);
    return record;
  }

  async function recipient(institutionId: string, data: { userId?: string; organType: string; bloodGroup: string; priority?: string; status?: string; distanceKm: number; maximumDistanceKm?: number }) {
    const location = { latitude: CENTRE.latitude - data.distanceKm / 111, longitude: CENTRE.longitude };
    const record = await db.database.organRecipient.create({ data: {
      reference: `TST-R-${suffix}-${++sequence}`, userId: data.userId, institutionId, organType: data.organType as never,
      bloodGroup: data.bloodGroup as never, priority: (data.priority ?? "NORMAL") as never, status: (data.status ?? "ACTIVE") as never,
      requirement: { create: { organType: data.organType as never, bloodGroup: data.bloodGroup as never, priority: (data.priority ?? "NORMAL") as never, ...location, maximumDistanceKm: data.maximumDistanceKm } },
    } });
    ids.recipients.push(record.id);
    return record;
  }

  test("IT-ORG-01 a living-donor organ moves from consent to an accepted offer only through the guarded steps, and a failed retrieval discards it", async () => {
    const offering = await centre("Offering centre");
    const receiving = await centre("Receiving centre", 5);
    const owner = centreActor(offering.id);
    const outsider = centreActor(receiving.id);
    const firstUser = await person("First Recipient");
    const urgentUser = await person("Urgent Recipient");

    // Consent and authorization.
    const donor = await db.database.organDonor.create({ data: {
      reference: `TST-D-${suffix}`, institutionId: offering.id, donorType: "LIVING", organType: "PANCREAS", consentStatus: "ACCEPTED", bloodGroup: "B_POSITIVE",
    } });
    ids.donors.push(donor.id);
    await assert.rejects(organ.authorizeOrganDonor(owner, donor.id, "AUTHORIZED"), rejectsWith(409, "CONSENT_NOT_VERIFIED"), "no authorization before consent is verified");
    await assert.rejects(organ.verifyDonorConsent(outsider, donor.id), rejectsWith(404), "another centre cannot see the donor");
    await organ.verifyDonorConsent(owner, donor.id);
    await organ.authorizeOrganDonor(owner, donor.id, "AUTHORIZED");
    await assert.rejects(organ.authorizeOrganDonor(owner, donor.id, "AUTHORIZED"), rejectsWith(409, "AUTHORIZATION_FINALIZED"));

    // Organ case registration and manual transitions.
    await assert.rejects(organ.createOrganRecord(owner, { donorId: donor.id, organType: "KIDNEY" }), rejectsWith(409, "ORGAN_TYPE_MISMATCH"));
    const record = await organ.createOrganRecord(owner, { donorId: donor.id, organType: "PANCREAS", bloodGroup: "B_POSITIVE" });
    assert.equal(record.status, "ASSESSMENT_PENDING");
    await assert.rejects(organ.createOrganRecord(owner, { donorId: donor.id, organType: "PANCREAS" }), rejectsWith(409, "ORGAN_CASE_EXISTS"));
    await assert.rejects(organ.transitionOrgan(owner, record.id, "ACCEPTED"), rejectsWith(409, "COORDINATION_ACTION_REQUIRED"), "acceptance cannot be set by hand");
    await assert.rejects(organ.transitionOrgan(owner, record.id, "TRANSPLANTED"), rejectsWith(409));
    await organ.transitionOrgan(owner, record.id, "ELIGIBLE_FOR_COORDINATION");

    // Rule-based candidate generation.
    const normal = await recipient(receiving.id, { userId: firstUser.id, organType: "PANCREAS", bloodGroup: "B_POSITIVE", distanceKm: 6, maximumDistanceKm: 100 });
    const urgent = await recipient(receiving.id, { userId: urgentUser.id, organType: "PANCREAS", bloodGroup: "B_POSITIVE", priority: "EMERGENCY", distanceKm: 6, maximumDistanceKm: 100 });
    const excluded = [
      await recipient(receiving.id, { organType: "PANCREAS", bloodGroup: "A_POSITIVE", distanceKm: 6 }),
      await recipient(receiving.id, { organType: "PANCREAS", bloodGroup: "B_POSITIVE", distanceKm: 67, maximumDistanceKm: 50 }),
      await recipient(receiving.id, { organType: "LIVER", bloodGroup: "B_POSITIVE", distanceKm: 6 }),
      await recipient(receiving.id, { organType: "PANCREAS", bloodGroup: "B_POSITIVE", status: "PENDING_REVIEW", distanceKm: 6 }),
    ];
    await assert.rejects(organ.generateOrganMatches(outsider, record.id, 100), rejectsWith(404));
    const generated = await organ.generateOrganMatches(owner, record.id, 100);
    assert.equal(generated.clinicalDecision, false);
    assert.deepEqual(generated.matches.map((match) => match.recipient.reference), [urgent.reference, normal.reference], `emergency first; ${excluded.length} ineligible recipients excluded`);
    const [urgentMatch, normalMatch] = generated.matches;

    // Review before offer.
    const deadline = () => new Date(Date.now() + 60 * 60_000);
    await assert.rejects(organ.createOrganOffer(owner, { matchId: urgentMatch!.id, responseDeadline: deadline() }), rejectsWith(409, "MATCH_NOT_SHORTLISTED"));
    await assert.rejects(organ.reviewOrganMatch(owner, urgentMatch!.id, "SHORTLISTED"), rejectsWith(409, "MATCH_NOT_REVIEWABLE"), "shortlisting requires a review first");
    for (const match of [urgentMatch!, normalMatch!]) {
      await organ.reviewOrganMatch(owner, match.id, "UNDER_REVIEW");
      await organ.reviewOrganMatch(owner, match.id, "SHORTLISTED");
    }
    await assert.rejects(organ.createOrganOffer(owner, { matchId: urgentMatch!.id, responseDeadline: new Date(Date.now() - 1000) }), rejectsWith(400, "INVALID_RESPONSE_DEADLINE"));

    // One offer at a time; only the recipient may answer, and only before the deadline.
    const urgentOffer = await organ.createOrganOffer(owner, { matchId: urgentMatch!.id, responseDeadline: deadline() });
    await assert.rejects(organ.createOrganOffer(owner, { matchId: normalMatch!.id, responseDeadline: deadline() }), rejectsWith(409, "ORGAN_NOT_OFFERABLE"), "no parallel offers for one organ");
    await assert.rejects(organ.respondToOrganOffer(personal(firstUser.id), urgentOffer.id, "ACCEPT"), rejectsWith(404), "another recipient cannot answer");
    await assert.rejects(organ.respondToOrganOffer(owner, urgentOffer.id, "ACCEPT"), rejectsWith(404), "the offering centre cannot answer for the recipient");
    await db.database.organOffer.update({ where: { id: urgentOffer.id }, data: { responseDeadline: new Date(Date.now() - 1000) } });
    await assert.rejects(organ.respondToOrganOffer(personal(urgentUser.id), urgentOffer.id, "ACCEPT"), rejectsWith(409, "OFFER_EXPIRED"));
    assert.ok(await organ.expireOrganOffers(new Date()) >= 1);
    assert.equal((await db.database.organOffer.findUniqueOrThrow({ where: { id: urgentOffer.id } })).status, "EXPIRED");
    assert.equal((await db.database.organRecord.findUniqueOrThrow({ where: { id: record.id } })).status, "AVAILABLE", "an expired offer releases the organ");

    // Next candidate accepts.
    const normalOffer = await organ.createOrganOffer(owner, { matchId: normalMatch!.id, responseDeadline: deadline() });
    const accepted = await organ.respondToOrganOffer(personal(firstUser.id), normalOffer.id, "ACCEPT");
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal((await db.database.organRecord.findUniqueOrThrow({ where: { id: record.id } })).status, "ACCEPTED");
    assert.equal((await db.database.organRecipient.findUniqueOrThrow({ where: { id: normal.id } })).status, "MATCHED");
    await assert.rejects(organ.respondToOrganOffer(personal(firstUser.id), normalOffer.id, "REJECT"), rejectsWith(409, "OFFER_NOT_RESPONDABLE"), "an answered offer cannot be changed");
    await assert.rejects(organ.transitionOrgan(owner, record.id, "FINAL_ASSESSMENT"), rejectsWith(409, "INVALID_ORGAN_TRANSITION"), "retrieval cannot be skipped after acceptance");
    await assert.rejects(organ.transitionOrgan(owner, record.id, "RETRIEVAL_SCHEDULED"), rejectsWith(409, "PROCUREMENT_WORKFLOW_REQUIRED"));

    // A failed retrieval discards the organ (as in the workflow diagram) and returns the recipient to the active list.
    const procurement = await organ.createOrganProcurement(owner, { organId: record.id, scheduledAt: new Date(Date.now() + 2 * 60 * 60_000) });
    await assert.rejects(organ.updateOrganProcurement(owner, procurement.id, "FAILED"), rejectsWith(409, "INVALID_PROCUREMENT_TRANSITION"), "retrieval must start before it can fail");
    await organ.updateOrganProcurement(owner, procurement.id, "IN_PROGRESS");
    await organ.updateOrganProcurement(owner, procurement.id, "FAILED");
    assert.equal((await db.database.organRecord.findUniqueOrThrow({ where: { id: record.id } })).status, "DISCARDED");
    assert.equal((await db.database.organRecipient.findUniqueOrThrow({ where: { id: normal.id } })).status, "ACTIVE", "the recipient can be matched with another organ");
    await assert.rejects(organ.transitionOrgan(owner, record.id, "AVAILABLE"), rejectsWith(409), "a discarded organ cannot re-enter matching");
  });
});

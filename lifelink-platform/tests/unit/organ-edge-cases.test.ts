import assert from "node:assert/strict";
import test from "node:test";
import { OrganStatus } from "@prisma/client";
import { calculatePreservationClock, isOrganTransitionAllowed, requireInstitution } from "../../apps/api/src/modules/organ-coordination/service";
import { organOfferSchema, personalOrganDonorSchema, preservationPolicySchema, recipientRequirementSchema } from "../../apps/api/src/middleware/validation";

// FR coverage: LL-FR-ORG (organ coordination), LL-FR-AUTH (institution scoping).

const ALL = Object.values(OrganStatus);
const TERMINAL: OrganStatus[] = [OrganStatus.COMPLETED, OrganStatus.EXPIRED, OrganStatus.DISCARDED, OrganStatus.CANCELLED];

function reachable(from: OrganStatus, without?: OrganStatus) {
  const seen = new Set<OrganStatus>([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of ALL) {
      if (next !== without && !seen.has(next) && isOrganTransitionAllowed(current, next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

test("UT-ORG-05 no organ can be transplanted without an accepted offer and a completed retrieval", () => {
  assert.equal(reachable(OrganStatus.REGISTERED, OrganStatus.ACCEPTED).has(OrganStatus.TRANSPLANTED), false);
  assert.equal(reachable(OrganStatus.REGISTERED, OrganStatus.OFFERED).has(OrganStatus.ACCEPTED), false);
  assert.equal(reachable(OrganStatus.REGISTERED, OrganStatus.RETRIEVAL_IN_PROGRESS).has(OrganStatus.RETRIEVED), false);
  assert.equal(reachable(OrganStatus.REGISTERED, OrganStatus.ASSESSMENT_PENDING).has(OrganStatus.ELIGIBLE_FOR_COORDINATION), false, "eligibility requires assessment");
});

test("UT-ORG-06 terminal organ states are final and every active case can still be closed", () => {
  for (const status of TERMINAL) assert.deepEqual(ALL.filter((next) => isOrganTransitionAllowed(status, next)), [], `${status} has no exits`);
  for (const status of ALL.filter((value) => !TERMINAL.includes(value))) {
    assert.ok([...reachable(status)].some((next) => TERMINAL.includes(next)), `${status} can reach a terminal state`);
  }
  assert.equal(isOrganTransitionAllowed(OrganStatus.TRANSPLANTED, OrganStatus.AVAILABLE), false, "a transplanted organ cannot re-enter matching");
  assert.equal(isOrganTransitionAllowed(OrganStatus.OFFERED, OrganStatus.OFFERED), false, "an organ cannot hold two parallel offers");
});

test("UT-ORG-07 every organ status declared in the schema is reachable from registration", () => {
  const fromRegistered = reachable(OrganStatus.REGISTERED);
  for (const status of ALL) assert.ok(fromRegistered.has(status), `${status} is reachable`);
  assert.equal(isOrganTransitionAllowed(OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.DISCARDED), true, "a failed retrieval discards the organ, as in the workflow diagram");
});

test("UT-ORG-08 preservation clock boundaries are inclusive and never report negative time", () => {
  const start = new Date("2026-10-05T00:00:00.000Z");
  const policy = { start, maximumHours: 24, warningHours: 8, criticalHours: 3 };
  const at = (hours: number) => calculatePreservationClock({ ...policy, now: new Date(start.getTime() + hours * 3_600_000) });
  assert.equal(at(16).status, "WARNING", "exactly 8 hours left is a warning");
  assert.equal(at(21).status, "CRITICAL", "exactly 3 hours left is critical");
  assert.equal(at(24).status, "EXPIRED", "exactly at the maximum is expired");
  assert.equal(at(30).remainingMs, 0);
  const clockSkew = at(-2);
  assert.equal(clockSkew.status, "NORMAL", "a start time in the future does not create negative elapsed time");
  assert.equal(clockSkew.elapsedMs, 0);
});

test("UT-ORG-09 organ coordination requires an organ-centre or an organ-enabled hospital", () => {
  const ok = (actor: Parameters<typeof requireInstitution>[0]) => { try { requireInstitution(actor); return true; } catch (error: any) { assert.equal(error.status, 403); return false; } };
  assert.equal(ok({ role: "ORGAN_CENTRE_USER", principalType: "INSTITUTION", institutionId: "centre-a" }), true);
  assert.equal(ok({ role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-a", capabilities: { blood: true, organ: true } }), true);
  assert.equal(ok({ role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-b", capabilities: { blood: true, organ: false } }), false);
  assert.equal(ok({ role: "BLOOD_BANK_USER", principalType: "INSTITUTION", institutionId: "bank-a", capabilities: { blood: true, organ: false } }), false);
  assert.equal(ok({ userId: "user-1", role: "USER", principalType: "USER" }), false);
  assert.equal(ok({ role: "ORGAN_CENTRE_USER", principalType: "INSTITUTION" }), false, "an organ role without an institution is rejected");
  assert.equal(ok({ userId: "admin", role: "ADMINISTRATOR", principalType: "USER" }), true);
});

test("UT-ORG-10 organ input validation rejects incomplete locations, unknown organs and inconsistent preservation policies", () => {
  const requirement = { organType: "KIDNEY", bloodGroup: "B_NEGATIVE", latitude: 22.7, longitude: 75.8, maximumDistanceKm: 200 };
  assert.equal(recipientRequirementSchema.safeParse(requirement).success, true);
  assert.equal(recipientRequirementSchema.safeParse({ ...requirement, longitude: undefined }).success, false, "one coordinate only");
  assert.equal(recipientRequirementSchema.safeParse({ ...requirement, organType: "SPLEEN" }).success, false);
  assert.equal(recipientRequirementSchema.safeParse({ ...requirement, maximumDistanceKm: 0 }).success, false);
  assert.equal(personalOrganDonorSchema.safeParse({ institutionId: "3f1c8a52-6d2e-4b7a-9f0e-1a2b3c4d5e6f", donorType: "LIVING", organTypes: [] }).success, false, "a donor pledge needs at least one organ");
  assert.equal(organOfferSchema.safeParse({ matchId: "not-a-uuid", responseDeadline: "2026-12-01" }).success, false);
  const policy = { organType: "LIVER", method: "STATIC_COLD_STORAGE", targetHours: 10, warningHours: 6, criticalHours: 2, maximumHours: 12 };
  assert.equal(preservationPolicySchema.safeParse(policy).success, true);
  assert.equal(preservationPolicySchema.safeParse({ ...policy, criticalHours: 8 }).success, false, "critical must not exceed warning");
  assert.equal(preservationPolicySchema.safeParse({ ...policy, maximumHours: 9 }).success, false, "maximum must be at least the target");
});

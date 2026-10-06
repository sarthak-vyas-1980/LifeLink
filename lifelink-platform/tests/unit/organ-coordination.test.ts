import assert from "node:assert/strict";
import test from "node:test";
import { OrganStatus } from "@prisma/client";
import { calculatePreservationClock, isOrganTransitionAllowed } from "../../apps/api/src/modules/organ-coordination/service";

test("organ transitions reject skipping procurement and terminal-state regressions", () => {
	assert.equal(isOrganTransitionAllowed(OrganStatus.ACCEPTED, OrganStatus.RETRIEVAL_SCHEDULED), true);
	assert.equal(isOrganTransitionAllowed(OrganStatus.ACCEPTED, OrganStatus.RETRIEVED), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.COMPLETED, OrganStatus.AVAILABLE), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT), true);
	assert.equal(isOrganTransitionAllowed(OrganStatus.PRESERVING, OrganStatus.IN_TRANSIT), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.IN_TRANSIT, OrganStatus.ARRIVED), false);
});

test("preservation clock calculates operational severity from configured thresholds", () => {
	const start = new Date("2026-10-05T00:00:00.000Z");
	const policy = { start, maximumHours: 10, warningHours: 5, criticalHours: 2 };
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T02:00:00.000Z") }).status, "NORMAL");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T06:00:00.000Z") }).status, "WARNING");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T09:00:00.000Z") }).status, "CRITICAL");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T10:01:00.000Z") }).status, "EXPIRED");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T06:00:00.000Z") }).remainingMs, 4 * 60 * 60 * 1000);
});

test("preservation timing without a start does not infer clinical suitability", () => {
	assert.deepEqual(calculatePreservationClock({ start: null, maximumHours: 24, warningHours: 8, criticalHours: 3 }), { status: "NOT_STARTED", elapsedMs: 0, remainingMs: 24 * 60 * 60 * 1000 });
});

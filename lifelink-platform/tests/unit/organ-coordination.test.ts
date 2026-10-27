import assert from "node:assert/strict";
import test from "node:test";
import { OrganStatus } from "@prisma/client";
import { calculatePreservationClock, isOrganTransitionAllowed } from "../../apps/api/src/modules/organ-coordination/service";

test("UT-ORG-01 organ transitions reject skipping procurement and terminal-state regressions", () => {
	assert.equal(isOrganTransitionAllowed(OrganStatus.ACCEPTED, OrganStatus.RETRIEVAL_SCHEDULED), true);
	assert.equal(isOrganTransitionAllowed(OrganStatus.ACCEPTED, OrganStatus.RETRIEVED), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.COMPLETED, OrganStatus.AVAILABLE), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT), true);
	assert.equal(isOrganTransitionAllowed(OrganStatus.ACCEPTED, OrganStatus.RETRIEVED), false);
	assert.equal(isOrganTransitionAllowed(OrganStatus.RETRIEVED, OrganStatus.PRESERVING), true);
});

test("UT-ORG-02 every organ status pair matches the explicit coordination graph", () => {
	const graph: Record<OrganStatus, OrganStatus[]> = {
		REGISTERED: [OrganStatus.ASSESSMENT_PENDING, OrganStatus.CANCELLED],
		ASSESSMENT_PENDING: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.UNAVAILABLE],
		ELIGIBLE_FOR_COORDINATION: [OrganStatus.AVAILABLE, OrganStatus.MATCHING, OrganStatus.OFFERED, OrganStatus.UNAVAILABLE],
		AVAILABLE: [OrganStatus.MATCHING, OrganStatus.UNAVAILABLE, OrganStatus.CANCELLED],
		MATCHING: [OrganStatus.OFFERED, OrganStatus.AVAILABLE, OrganStatus.UNAVAILABLE],
		OFFERED: [OrganStatus.ACCEPTED, OrganStatus.AVAILABLE, OrganStatus.EXPIRED, OrganStatus.CANCELLED],
		ACCEPTED: [OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.CANCELLED],
		RETRIEVAL_SCHEDULED: [OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.CANCELLED],
		RETRIEVAL_IN_PROGRESS: [OrganStatus.RETRIEVED, OrganStatus.CANCELLED, OrganStatus.UNAVAILABLE, OrganStatus.DISCARDED],
		RETRIEVED: [OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT],
		PRESERVING: [OrganStatus.FINAL_ASSESSMENT, OrganStatus.UNAVAILABLE, OrganStatus.EXPIRED],
		FINAL_ASSESSMENT: [OrganStatus.ALLOCATED, OrganStatus.UNAVAILABLE],
		ALLOCATED: [OrganStatus.TRANSPLANTED],
		TRANSPLANTED: [OrganStatus.COMPLETED],
		COMPLETED: [], UNAVAILABLE: [OrganStatus.CANCELLED], EXPIRED: [], DISCARDED: [], CANCELLED: [],
	};
	const statuses = Object.values(OrganStatus);
	assert.equal(Object.keys(graph).length, statuses.length, "graph must include each enum status");
	for (const from of statuses) for (const to of statuses) {
		assert.equal(isOrganTransitionAllowed(from, to), graph[from].includes(to), `${from} -> ${to}`);
	}
});

test("UT-ORG-03 preservation clock calculates operational severity from configured thresholds", () => {
	const start = new Date("2026-10-05T00:00:00.000Z");
	const policy = { start, maximumHours: 10, warningHours: 5, criticalHours: 2 };
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T02:00:00.000Z") }).status, "NORMAL");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T06:00:00.000Z") }).status, "WARNING");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T09:00:00.000Z") }).status, "CRITICAL");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T10:01:00.000Z") }).status, "EXPIRED");
	assert.equal(calculatePreservationClock({ ...policy, now: new Date("2026-10-05T06:00:00.000Z") }).remainingMs, 4 * 60 * 60 * 1000);
});

test("UT-ORG-04 preservation timing without a start does not infer clinical suitability", () => {
	assert.deepEqual(calculatePreservationClock({ start: null, maximumHours: 24, warningHours: 8, criticalHours: 3 }), { status: "NOT_STARTED", elapsedMs: 0, remainingMs: 24 * 60 * 60 * 1000 });
});

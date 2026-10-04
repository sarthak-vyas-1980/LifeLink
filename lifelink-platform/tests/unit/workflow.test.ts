import assert from "node:assert/strict";
import test from "node:test";
import { BLOOD_REQUEST_TRANSITIONS, REQUEST_STATUSES, isAllowedTransition } from "@lifelink/shared";

test("every documented request transition is legal and every other pair is rejected", () => {
  for (const from of REQUEST_STATUSES) {
    for (const to of REQUEST_STATUSES) {
      assert.equal(isAllowedTransition(from, to), BLOOD_REQUEST_TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    }
  }
});

test("terminal request states have no outgoing transitions", () => {
  for (const state of ["FULFILLED", "CANCELLED", "REJECTED", "EXPIRED"] as const) {
    assert.deepEqual(BLOOD_REQUEST_TRANSITIONS[state], []);
  }
});

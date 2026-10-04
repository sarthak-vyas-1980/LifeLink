import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mayReadRequest, assertMayCoordinate } from "../../apps/api/src/modules/requests/blood.routes";
import { rememberEventForDelivery } from "../../apps/api/src/modules/notifications/realtime.gateway";

const request = {
  createdById: "requester",
  createdBy: { institutionId: "hospital-a" },
  recipients: [{ userId: "recipient" }],
  matches: [{ providerInstitutionId: "bank-a" }],
} as never;

test("request reads are limited to requester, recipient, linked institutions, or admin", () => {
  for (const userId of ["requester", "recipient"]) {
    assert.equal(mayReadRequest(request, { userId, role: "DONOR_RECIPIENT" }), true);
  }
  assert.equal(mayReadRequest(request, { userId: "hospital-user", role: "HOSPITAL_USER", institutionId: "hospital-a" }), true);
  assert.equal(mayReadRequest(request, { userId: "bank-user", role: "BLOOD_BANK_USER", institutionId: "bank-a" }), true);
  assert.equal(mayReadRequest(request, { userId: "admin", role: "ADMINISTRATOR" }), true);
  assert.equal(mayReadRequest(request, { userId: "outsider", role: "DONOR_RECIPIENT" }), false);
});

test("a provider cannot coordinate another institution's request", () => {
  assert.throws(() => assertMayCoordinate(request, { userId: "provider", role: "BLOOD_BANK_USER", institutionId: "bank-a" }), { status: 404 });
  assert.doesNotThrow(() => assertMayCoordinate(request, { userId: "hospital-user", role: "HOSPITAL_USER", institutionId: "hospital-a" }));
});

test("duplicate workflow event delivery is idempotently suppressed", () => {
  const eventId = `test-event-${randomUUID()}`;
  assert.equal(rememberEventForDelivery(eventId), true);
  assert.equal(rememberEventForDelivery(eventId), false);
});

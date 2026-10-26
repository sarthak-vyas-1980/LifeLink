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
    assert.equal(mayReadRequest(request, { userId, role: "USER", principalType: "USER" }), true);
  }
  assert.equal(mayReadRequest(request, { role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-a", capabilities: { blood: true, organ: false } }), true);
  assert.equal(mayReadRequest(request, { role: "BLOOD_BANK_USER", principalType: "INSTITUTION", institutionId: "bank-a", capabilities: { blood: true, organ: false } }), true);
  assert.equal(mayReadRequest(request, { userId: "admin", role: "ADMINISTRATOR", principalType: "USER" }), true);
  assert.equal(mayReadRequest(request, { userId: "outsider", role: "USER", principalType: "USER" }), false);
});

test("a provider cannot coordinate another institution's request", () => {
  assert.throws(() => assertMayCoordinate(request, { role: "BLOOD_BANK_USER", principalType: "INSTITUTION", institutionId: "bank-a", capabilities: { blood: true, organ: false } }), { status: 404 });
  assert.doesNotThrow(() => assertMayCoordinate(request, { role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-a", capabilities: { blood: true, organ: false } }));
});

test("duplicate workflow event delivery is idempotently suppressed", () => {
  const eventId = `test-event-${randomUUID()}`;
  assert.equal(rememberEventForDelivery(eventId), true);
  assert.equal(rememberEventForDelivery(eventId), false);
});

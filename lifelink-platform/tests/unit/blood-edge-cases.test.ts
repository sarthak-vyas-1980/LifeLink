import assert from "node:assert/strict";
import test from "node:test";
import { BLOOD_REQUEST_TRANSITIONS, FINAL_REQUEST_STATUSES, REQUEST_STATUSES, type RequestStatus } from "@lifelink/shared";
import { bloodInventorySchema, bloodRequestSchema, emergencyBloodRequestSchema, registrationSchema } from "../../apps/api/src/middleware/validation";
import { findBloodMatches, rankMatches, type BloodMatchCandidate } from "../../apps/api/src/modules/requests/matching.service";
import { calculateDistance, filterFacilitiesByRadius, rankNearbyFacilities } from "../../apps/api/src/modules/maps/geospatial.service";
import { serializeBloodMatchingResult, serializeRequestForActor } from "../../apps/api/src/security/field-policy";
import { assertMayCoordinate } from "../../apps/api/src/modules/requests/blood.routes";
import { consumeReservedBloodUnits, releaseReservedBloodUnits, reserveBloodUnits } from "../../packages/database/src/repositories/inventory.repository";

// FR coverage: LL-FR-BREQ (requests and matching), LL-FR-INV (inventory), LL-FR-EMG, LL-FR-AUTH.

const validRequest = {
  bloodGroup: "O_NEGATIVE", component: "RED_BLOOD_CELLS", quantity: 2, priority: "URGENT",
  location: "MY Hospital, Indore", latitude: 22.7196, longitude: 75.8577, radiusKm: 25, contactNumber: "+91 98765 43210",
};

test("UT-BLD-03 blood request validation accepts a complete request and rejects impossible or half-specified input", () => {
  assert.equal(bloodRequestSchema.safeParse(validRequest).success, true);
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["zero units", { quantity: 0 }],
    ["negative units", { quantity: -3 }],
    ["fractional units", { quantity: 2.5 }],
    ["quantity sent as text", { quantity: "2" }],
    ["display-style blood group", { bloodGroup: "O+" }],
    ["unknown component", { component: "BLOOD" }],
    ["EMERGENCY on the standard route", { priority: "EMERGENCY" }],
    ["latitude without longitude", { longitude: undefined }],
    ["radius without coordinates", { latitude: undefined, longitude: undefined }],
    ["radius beyond 500 km", { radiusKm: 501 }],
    ["latitude off the globe", { latitude: 91 }],
    ["blank location", { location: "   " }],
    ["contact number too short", { contactNumber: "123" }],
  ];
  for (const [label, change] of invalid) {
    assert.equal(bloodRequestSchema.safeParse({ ...validRequest, ...change }).success, false, label);
  }
});

test("UT-BLD-04 emergency requests ignore any client-supplied priority so it cannot be downgraded", () => {
  const parsed = emergencyBloodRequestSchema.safeParse({ ...validRequest, priority: "NORMAL" });
  assert.equal(parsed.success, true);
  assert.equal("priority" in (parsed.success ? parsed.data : {}), false);
});

test("UT-BLD-05 inventory validation allows a stock-out but rejects negative, fractional and unscoped records", () => {
  const record = { institutionId: "3f1c8a52-6d2e-4b7a-9f0e-1a2b3c4d5e6f", bloodGroup: "B_POSITIVE", component: "PLASMA", unitsAvailable: 0 };
  assert.equal(bloodInventorySchema.safeParse(record).success, true);
  assert.equal(bloodInventorySchema.safeParse({ ...record, unitsAvailable: -1 }).success, false);
  assert.equal(bloodInventorySchema.safeParse({ ...record, unitsAvailable: 1.5 }).success, false);
  assert.equal(bloodInventorySchema.safeParse({ ...record, institutionId: "hospital-a" }).success, false);
});

test("UT-BLD-06 the matcher rejects invalid search criteria before it queries any inventory", async () => {
  const base = { requestId: "request-1", bloodGroup: "A_POSITIVE" as const, component: "PLATELETS" as const, quantity: 1 };
  const invalid: Array<[string, Partial<Parameters<typeof findBloodMatches>[0]>]> = [
    ["zero quantity", { quantity: 0 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["latitude only", { latitude: 22.7 }],
    ["latitude out of range", { latitude: 95, longitude: 75 }],
    ["longitude out of range", { latitude: 22, longitude: 190 }],
    ["zero radius", { latitude: 22.7, longitude: 75.8, radiusKm: 0 }],
    ["radius over the limit", { latitude: 22.7, longitude: 75.8, radiusKm: 501 }],
    ["radius without coordinates", { radiusKm: 10 }],
    ["non-positive freshness window", { freshnessMinutes: 0 }],
  ];
  for (const [label, change] of invalid) {
    await assert.rejects(findBloodMatches({ ...base, ...change }), (error: any) => error.status === 400 && error.code === "INVALID_MATCH_CRITERIA", label);
  }
});

test("UT-BLD-07 candidate ranking prefers the higher score, then the nearer provider, and never promises fulfilment", () => {
  const candidate = (id: string, score: number, distanceKm?: number): BloodMatchCandidate => ({
    inventoryId: id, institutionId: id, institutionName: id, unitsAvailable: 5, expiryDate: null, lastUpdated: new Date(),
    distanceKm, freshnessMinutes: 10, score, guaranteedFulfilment: false,
  });
  const ranked = rankMatches([candidate("far", 0.8, 40), candidate("unknown", 0.8), candidate("near", 0.8, 5), candidate("best", 0.95, 90)]);
  assert.deepEqual(ranked.map((item) => item.inventoryId), ["best", "near", "far", "unknown"]);
  const serialized = serializeBloodMatchingResult({ status: "MATCHES_FOUND", candidates: [{ ...candidate("kept", 0.9, 3), matchId: "match-1" }, candidate("unsaved", 0.9, 3)], retry: { canWidenRadius: true } });
  assert.equal(serialized.candidates.length, 1, "candidates that were not persisted as offers are not shown");
  assert.equal(serialized.candidates[0]?.guaranteedFulfilment, false);
});

test("UT-BLD-08 distance and radius filters use real geography and exclude providers with unknown location", () => {
  const indoreToBhopal = calculateDistance(22.7196, 75.8577, 23.2599, 77.4126);
  assert.ok(indoreToBhopal > 165 && indoreToBhopal < 175, `Indore-Bhopal was ${indoreToBhopal}`);
  assert.equal(calculateDistance(22.7196, 75.8577, 22.7196, 75.8577), 0);
  const facilities = [{ id: "edge", distanceKm: 25 }, { id: "unknown" }, { id: "inside", distanceKm: 3 }, { id: "outside", distanceKm: 25.01 }];
  assert.deepEqual(filterFacilitiesByRadius(facilities, 25).map((item) => item.id), ["edge", "inside"]);
  assert.equal(filterFacilitiesByRadius(facilities).length, 4, "without a radius nothing is filtered");
  assert.deepEqual(rankNearbyFacilities(facilities).map((item) => item.id), ["inside", "edge", "outside", "unknown"]);
});

test("UT-BLD-09 a requester's contact number is visible only to the requester, the requesting institution and administrators", () => {
  const userRequest = { id: "r1", requestType: "BLOOD", quantity: 1, priority: "NORMAL", location: "Indore", status: "INSTITUTIONS_NOTIFIED", createdById: "user-1", createdByInstitutionId: null, contactNumber: "+919999999999" } as const;
  const hospitalRequest = { ...userRequest, createdById: null, createdByInstitutionId: "hospital-a" };
  const sees = (record: typeof userRequest | typeof hospitalRequest, actor: Parameters<typeof serializeRequestForActor>[1]) => "contactNumber" in serializeRequestForActor(record as never, actor);
  assert.equal(sees(userRequest, { userId: "user-1", role: "USER", principalType: "USER" }), true);
  assert.equal(sees(userRequest, { userId: "admin", role: "ADMINISTRATOR", principalType: "USER" }), true);
  assert.equal(sees(userRequest, { userId: "user-2", role: "USER", principalType: "USER" }), false);
  assert.equal(sees(userRequest, { role: "BLOOD_BANK_USER", principalType: "INSTITUTION", institutionId: "bank-a" }), false);
  assert.equal(sees(hospitalRequest, { role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-a" }), true);
  assert.equal(sees(hospitalRequest, { userId: "user-1", role: "USER", principalType: "USER" }), false);
  assert.equal(sees(hospitalRequest, undefined), false);
});

function reachable(from: RequestStatus, without?: RequestStatus) {
  const seen = new Set<RequestStatus>([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of BLOOD_REQUEST_TRANSITIONS[queue.shift()!]) {
      if (next !== without && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

test("UT-BLD-10 the request state machine has no dead ends and every active request can still be closed", () => {
  const fromCreated = reachable("CREATED");
  for (const status of REQUEST_STATUSES) assert.ok(fromCreated.has(status), `${status} is reachable from CREATED`);
  for (const status of REQUEST_STATUSES.filter((value) => !FINAL_REQUEST_STATUSES.includes(value))) {
    assert.ok([...reachable(status)].some((next) => FINAL_REQUEST_STATUSES.includes(next)), `${status} can reach a final state`);
  }
});

test("UT-BLD-11 no request can be fulfilled without a reservation, and no reservation happens without provider confirmation", () => {
  assert.equal(reachable("CREATED", "RESERVED").has("FULFILLED"), false);
  assert.equal(reachable("CREATED", "OFFERS_RECEIVED").has("RESERVED"), false);
  assert.equal(reachable("CREATED", "OFFER_ACCEPTED").has("RESERVED"), false);
});

function fakeInventory(initial: { unitsAvailable: number; expiryDate?: Date | null }) {
  const inventory = { unitsAvailable: initial.unitsAvailable, reservedUnits: 0, status: "AVAILABLE", expiryDate: initial.expiryDate ?? null };
  const transaction = {
    bloodInventory: {
      updateMany: async ({ where, data }: any) => {
        if (where.status && inventory.status !== where.status) return { count: 0 };
        if (where.unitsAvailable && inventory.unitsAvailable < where.unitsAvailable.gte) return { count: 0 };
        if (where.reservedUnits && inventory.reservedUnits < where.reservedUnits.gte) return { count: 0 };
        if (where.OR && inventory.expiryDate && inventory.expiryDate <= new Date()) return { count: 0 };
        inventory.unitsAvailable += (data.unitsAvailable?.increment ?? 0) - (data.unitsAvailable?.decrement ?? 0);
        inventory.reservedUnits += (data.reservedUnits?.increment ?? 0) - (data.reservedUnits?.decrement ?? 0);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...inventory }),
      update: async ({ data }: any) => { inventory.status = data.status; return { ...inventory }; },
    },
    auditLog: { create: async () => ({}) },
  };
  return { inventory, transaction: transaction as never };
}

test("UT-BLD-12 stock status follows the units: reserving the last unit marks it RESERVED, consuming it marks it UNAVAILABLE", async () => {
  const { inventory, transaction } = fakeInventory({ unitsAvailable: 2 });
  await reserveBloodUnits(transaction, "inventory", 2);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits, inventory.status], [0, 2, "RESERVED"]);
  await assert.rejects(reserveBloodUnits(transaction, "inventory", 1), /unavailable/, "a fully reserved record cannot be reserved again");
  await releaseReservedBloodUnits(transaction, "inventory", 1);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits, inventory.status], [1, 1, "AVAILABLE"]);
  await reserveBloodUnits(transaction, "inventory", 1);
  await consumeReservedBloodUnits(transaction, "inventory", 2);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits, inventory.status], [0, 0, "UNAVAILABLE"]);
});

test("UT-BLD-13 expired stock cannot be reserved even when units are recorded as available", async () => {
  const { inventory, transaction } = fakeInventory({ unitsAvailable: 4, expiryDate: new Date(Date.now() - 60_000) });
  await assert.rejects(reserveBloodUnits(transaction, "inventory", 1), /unavailable/);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [4, 0]);
});

test("UT-BLD-14 coordination stays with the requester: the hospital that raised a request may act, its provider may not", () => {
  const hospitalRequest = { createdById: null, createdByInstitutionId: "hospital-a", recipients: [], matches: [{ providerInstitutionId: "bank-a" }] } as never;
  assert.doesNotThrow(() => assertMayCoordinate(hospitalRequest, { role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "hospital-a", capabilities: { blood: true, organ: false } }));
  assert.throws(() => assertMayCoordinate(hospitalRequest, { role: "BLOOD_BANK_USER", principalType: "INSTITUTION", institutionId: "bank-a", capabilities: { blood: true, organ: false } }), { status: 404 });
});

test("UT-BLD-15 public registration cannot create an administrator account", () => {
  const person = { name: "Mallory", email: "mallory@example.test", phone: "+91 98765 43210", password: "secret123", accountType: "USER" };
  const asAdmin = registrationSchema.safeParse({ ...person, role: "ADMIN" });
  assert.equal(asAdmin.success, false);
  assert.match(asAdmin.success ? "" : asAdmin.error.issues[0]!.message, /cannot be created through public registration/);
  assert.equal(registrationSchema.safeParse(person).success, true, "a personal account needs no role");
  assert.equal(registrationSchema.safeParse({ ...person, role: "USER" }).success, true, "older clients that still send USER keep working");
});

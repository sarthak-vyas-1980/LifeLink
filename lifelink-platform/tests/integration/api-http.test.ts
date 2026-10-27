import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import jwt from "jsonwebtoken";
import { cleanupBloodRecords, createdRecords, skipReason, useTestDatabase } from "./support";

// FR coverage through the real Express routes: LL-FR-AUTH, LL-FR-INV, LL-FR-BREQ (validation),
// blood donation (interest -> screening -> stock), LL-FR-RAG input limits.

type DatabaseModule = typeof import("../../packages/database/src/index");

describe("HTTP API edge cases (in-process server, PostgreSQL)", { skip: skipReason }, () => {
  let db: DatabaseModule;
  let server: Server;
  let baseUrl = "";
  let stopWorkers: () => void = () => {};
  const created = createdRecords();
  const suffix = randomUUID().slice(0, 8);
  const phone = "+91 98765 43210";
  const password = "integration-pass-1";

  before(async () => {
    useTestDatabase();
    process.env.GEOCODING_ENDPOINT = "http://127.0.0.1:9/search"; // keep registration geocoding offline
    db = await import("../../packages/database/src/index");
    const { createApp } = await import("../../apps/api/src/app");
    ({ stopOrganCoordinationWorkers: stopWorkers } = await import("../../apps/api/src/modules/organ-coordination/routes"));
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    stopWorkers();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!db) return;
    await cleanupBloodRecords(db.database, created);
    await db.database.$disconnect();
  });

  async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  }

  async function register(kind: "USER" | "BLOOD_BANK" | "HOSPITAL", name: string, extra: Record<string, unknown> = {}) {
    const email = `${name.toLowerCase().replaceAll(" ", ".")}-${suffix}@example.test`;
    const body = kind === "USER"
      ? { name, email, phone, password, accountType: "USER", role: "USER", ...extra }
      : { name: `${name} ${suffix}`, email, phone, password, accountType: "INSTITUTION", institutionType: kind, address: "Integration Road, Indore", ...extra };
    const result = await call("POST", "/api/auth/register", { body });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    (kind === "USER" ? created.users : created.institutions).push(result.body.user.id);
    return { id: result.body.user.id as string, token: result.body.token as string, email };
  }

  test("IT-API-01 authentication rejects missing, forged, wrong-credential and deactivated sessions", async () => {
    const bank = await register("BLOOD_BANK", "Auth bank");
    assert.equal((await call("GET", "/api/notifications")).status, 401);
    assert.equal((await call("GET", "/api/notifications", { token: "not-a-jwt" })).status, 401);
    const forged = jwt.sign({ role: "ADMINISTRATOR", principalType: "USER" }, "attacker-secret", { subject: randomUUID(), expiresIn: "1h" });
    assert.equal((await call("GET", "/api/admin/overview", { token: forged })).status, 401, "a token signed with another secret is refused");
    assert.equal((await call("POST", "/api/auth/login", { body: { email: bank.email, phone, password: "wrong-password", accountType: "INSTITUTION" } })).status, 401);
    assert.equal((await call("POST", "/api/auth/login", { body: { email: bank.email, phone: "+91 90000 00000", password, accountType: "INSTITUTION" } })).status, 401, "password alone is not enough without the registered phone");
    assert.equal((await call("POST", "/api/auth/login", { body: { email: bank.email, phone, password, accountType: "INSTITUTION" } })).status, 200);
    await db.database.institution.update({ where: { id: bank.id }, data: { status: "INACTIVE" } });
    const afterDeactivation = await call("GET", "/api/notifications", { token: bank.token });
    assert.equal(afterDeactivation.status, 401, "an existing token stops working once the institution is deactivated");
  });

  test("IT-API-02 role, institution scope and capability checks protect inventory writes", async () => {
    const bank = await register("BLOOD_BANK", "Scope bank");
    const otherBank = await register("BLOOD_BANK", "Scope other bank");
    const plainHospital = await register("HOSPITAL", "No blood hospital");
    const person = await register("USER", "Scope Person");
    const record = (institutionId: string) => ({ institutionId, bloodGroup: "A_POSITIVE", component: "PLASMA", unitsAvailable: 3 });
    assert.equal((await call("POST", "/api/inventory/blood", { token: person.token, body: record(bank.id) })).status, 403, "personal users cannot write stock");
    const crossScope = await call("POST", "/api/inventory/blood", { token: bank.token, body: record(otherBank.id) });
    assert.equal(crossScope.status, 403);
    assert.equal(crossScope.body.code, "INSTITUTION_SCOPE_FORBIDDEN");
    const noCapability = await call("POST", "/api/inventory/blood", { token: plainHospital.token, body: record(plainHospital.id) });
    assert.equal(noCapability.body.code, "INSTITUTION_CAPABILITY_REQUIRED");
    assert.equal((await call("POST", "/api/inventory/blood", { token: bank.token, body: { ...record(bank.id), unitsAvailable: -2 } })).status, 400);
    assert.equal((await call("POST", "/api/inventory/blood", { token: bank.token, body: record(bank.id) })).status, 201);
  });

  test("IT-API-03 request and assistant endpoints reject malformed input before any work is done", async () => {
    const person = await register("USER", "Validation Person");
    const badRequest = await call("POST", "/api/requests/blood", { token: person.token, body: { bloodGroup: "O_POSITIVE", component: "PLASMA", quantity: 0, priority: "NORMAL", location: "Indore", contactNumber: "+911234567890" } });
    assert.equal(badRequest.status, 400);
    assert.ok(badRequest.body.fieldErrors?.quantity);
    assert.equal((await call("GET", "/api/requests/blood/not-a-uuid", { token: person.token })).status, 400);
    assert.equal((await call("POST", "/api/rag/query", { body: { message: "hello" } })).status, 401);
    assert.equal((await call("POST", "/api/rag/query", { token: person.token, body: { message: "x".repeat(2001) } })).status, 400);
    const tooMuchHistory = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "turn" }));
    assert.equal((await call("POST", "/api/rag/query", { token: person.token, body: { message: "hi", history: tooMuchHistory } })).status, 400);
  });

  test("IT-API-04 a blood bank registered through the app can receive donation interest", async () => {
    const bank = await register("BLOOD_BANK", "Fresh bank");
    const donor = await register("USER", "Fresh Donor");
    const result = await call("POST", "/api/blood-donations", { token: donor.token, body: { institutionId: bank.id, bloodGroup: "O_POSITIVE" } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  });

  test("IT-API-05 donation interest never adds stock until the institution records a screened, verified unit", async () => {
    const bank = await register("BLOOD_BANK", "Donation bank");
    const otherBank = await register("BLOOD_BANK", "Donation other bank");
    const donor = await register("USER", "Donor Person");
    const stockCount = async () => (await call("GET", `/api/inventory/blood?institutionId=${bank.id}`, { token: bank.token })).body.records.length as number;

    const interest = await call("POST", "/api/blood-donations", { token: donor.token, body: { institutionId: bank.id, bloodGroup: "A_POSITIVE" } });
    assert.equal(interest.status, 201);
    assert.equal(interest.body.donation.status, "PENDING");
    assert.equal(await stockCount(), 0, "registering interest is not a donation");
    const donationId = interest.body.donation.id;
    const status = (body: unknown, token = bank.token) => call("PATCH", `/api/blood-donations/${donationId}/status`, { token, body });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    assert.equal((await status({ status: "ACCEPTED" }, otherBank.token)).status, 404, "another institution cannot see this donor");
    assert.equal((await status({ status: "ACCEPTED" }, donor.token)).status, 403, "the donor cannot approve themselves");
    assert.equal((await status({ status: "COMPLETED", verifiedBloodGroup: "A_POSITIVE", expiryDate: nextWeek })).status, 409, "screening (ACCEPTED) cannot be skipped");
    assert.equal((await status({ status: "ACCEPTED" })).status, 200);
    assert.equal((await status({ status: "COMPLETED", expiryDate: nextWeek })).status, 400, "the blood group must be verified");
    assert.equal((await status({ status: "COMPLETED", verifiedBloodGroup: "A_POSITIVE", expiryDate: "2020-01-01" })).status, 400, "an expired unit cannot enter stock");

    const completed = await status({ status: "COMPLETED", verifiedBloodGroup: "A_NEGATIVE", expiryDate: nextWeek });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.inventory?.id !== undefined, true);
    const unit = await db.database.bloodInventory.findUniqueOrThrow({ where: { id: completed.body.inventory.id } });
    assert.deepEqual([unit.bloodGroup, unit.component, unit.unitsAvailable], ["A_NEGATIVE", "WHOLE_BLOOD", 1], "stock uses the verified group, not the self-reported one");
    assert.equal((await status({ status: "COMPLETED", verifiedBloodGroup: "A_NEGATIVE", expiryDate: nextWeek })).status, 409, "a donation cannot add stock twice");
    assert.equal((await call("POST", `/api/blood-donations/${donationId}/cancel`, { token: donor.token })).status, 409, "a completed donation cannot be withdrawn");
  });

  test("IT-API-06 public registration cannot create an administrator", async () => {
    const email = `mallory-${suffix}@example.test`;
    const result = await call("POST", "/api/auth/register", { body: { name: "Mallory", email, phone, password, accountType: "USER", role: "ADMIN" } });
    if (result.status === 201) created.users.push(result.body.user.id);
    assert.equal(result.status, 400, `expected a validation error, got ${result.status} with role ${result.body?.user?.role}`);
    assert.ok(result.body.fieldErrors?.role, "the response explains that the role is not allowed");
    assert.equal(await db.database.user.count({ where: { email } }), 0, "no account was created");
    const person = await register("USER", "Plain Person", { role: undefined });
    const profile = await call("GET", "/api/users/me", { token: person.token });
    assert.equal(profile.status, 200);
    assert.equal((await db.database.user.findUniqueOrThrow({ where: { id: person.id } })).role, "USER");
  });

  test("IT-API-07 blood banks can see and answer requests but cannot raise them", async () => {
    const bank = await register("BLOOD_BANK", "Provider only bank");
    const body = { bloodGroup: "O_POSITIVE", component: "PLASMA", quantity: 1, priority: "NORMAL", location: "Indore", contactNumber: "+911234567890" };
    const standard = await call("POST", "/api/requests/blood", { token: bank.token, body });
    assert.equal(standard.status, 403);
    const emergency = await call("POST", "/api/emergency/blood-requests", { token: bank.token, body });
    assert.equal(emergency.status, 403);
    assert.equal((await call("GET", "/api/requests/blood", { token: bank.token })).status, 200, "blood banks still list the requests they were offered");
    const hospital = await register("HOSPITAL", "Requesting hospital", { bloodServiceEnabled: true });
    assert.equal((await call("POST", "/api/requests/blood", { token: hospital.token, body })).status, 201, "hospitals still raise requests");
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { cleanupBloodRecords, createdRecords, skipReason, useTestDatabase } from "./support";

// FR coverage: LL-FR-RAG-007/-008 — the assistant's live-data answers come from real PostgreSQL records
// (inventory summary, registered-institution directory, the caller's own donation status), never from text.

type DatabaseModule = typeof import("../../packages/database/src/index");
type OrchestratorModule = typeof import("../../apps/api/src/modules/rag/orchestrator");

describe("assistant live-data answers (PostgreSQL)", { skip: skipReason }, () => {
  let db: DatabaseModule;
  let assistant: OrchestratorModule;
  const created = createdRecords();
  const suffix = randomUUID().slice(0, 8);
  let donorId = "";
  let otherUserId = "";
  let bankName = "";
  let bankId = "";

  before(async () => {
    useTestDatabase();
    db = await import("../../packages/database/src/index");
    assistant = await import("../../apps/api/src/modules/rag/orchestrator");
    bankName = `AAA Assistant Test Bank ${suffix}`;
    const bank = await db.database.institution.create({ data: { name: bankName, type: "BLOOD_BANK", status: "ACTIVE", address: "Integration test site", contactNumber: "+91 731 555 0101" } });
    created.institutions.push(bank.id);
    bankId = bank.id;
    for (const [bloodGroup, unitsAvailable] of [["O_POSITIVE", 7], ["B_NEGATIVE", 3]] as const) {
      const record = await db.database.bloodInventory.create({ data: { institutionId: bank.id, bloodGroup, component: "WHOLE_BLOOD", unitsAvailable, expiryDate: new Date(Date.now() + 10 * 86_400_000) } });
      created.inventory.push(record.id);
    }
    const makeUser = async (label: string) => {
      const record = await db.database.user.create({ data: { name: `Assistant ${label} ${suffix}`, email: `assistant-${label}-${suffix}@example.test`, phone: "+911234567890", passwordHash: "not-a-real-hash", role: "USER" } });
      created.users.push(record.id);
      return record.id;
    };
    donorId = await makeUser("donor");
    otherUserId = await makeUser("other");
    await db.database.donation.create({ data: { donorId, providerInstitutionId: bank.id, donationType: "BLOOD", bloodGroup: "O_POSITIVE", status: "PENDING" } });
  });

  after(async () => {
    if (!db) return;
    await cleanupBloodRecords(db.database, created);
    await db.database.$disconnect();
  });

  const actor = (userId: string) => ({ userId, role: "USER" as const, principalType: "USER" as const });

  test("IT-AI-01 'show me the available blood inventory' summarises real records by blood group", async () => {
    const result = await assistant.generateAssistantResponse({ message: "Show me the available blood inventory.", actor: actor(donorId), history: [] });
    assert.equal(result.intent, "LIVE_INVENTORY");
    assert.equal(result.status, "ANSWERED");
    assert.equal(result.liveDataUsed, true);
    const summary = result.data?.summary as Array<{ bloodGroup: string; units: number }>;
    assert.ok(summary.find((item) => item.bloodGroup === "O_POSITIVE")!.units >= 7);
    assert.ok(summary.find((item) => item.bloodGroup === "B_NEGATIVE")!.units >= 3);
    assert.match(result.answer, /not a guarantee/);
  });

  test("IT-AI-02 'which blood banks are registered on LifeLink' lists the active directory", async () => {
    const result = await assistant.generateAssistantResponse({ message: "Which blood banks are registered on LifeLink?", actor: actor(donorId), history: [] });
    assert.equal(result.intent, "FACILITY_DISCOVERY");
    assert.equal(result.data?.directory, true);
    const facilities = result.data?.facilities as Array<{ name: string; source: string; phone: string | null }>;
    const bank = facilities.find((facility) => facility.name === bankName);
    assert.ok(bank, "the active test bank should be in the directory");
    assert.equal(bank.source, "LIFELINK");
    assert.equal(bank.phone, "+91 731 555 0101");
    const expected = facilities.length > 1 ? "Show me the first one again" : "What about its contact number?";
    assert.ok(result.suggestions?.includes(expected), `suggestions should offer "${expected}"`);
  });

  test("IT-AI-03 donation status comes from the caller's own records only", async () => {
    const mine = await assistant.generateAssistantResponse({ message: "What is the current status of my donation request?", actor: actor(donorId), history: [] });
    assert.equal(mine.intent, "REQUEST_STATUS");
    assert.equal(mine.liveDataUsed, true);
    assert.match(mine.answer, new RegExp(bankName));
    assert.match(mine.answer, /PENDING/);

    const other = await assistant.generateAssistantResponse({ message: "What is the current status of my donation request?", actor: actor(otherUserId), history: [] });
    assert.equal(other.status, "NO_RESULTS");
    assert.doesNotMatch(other.answer, new RegExp(bankName));
  });

  test("IT-AI-04 'is blood available at that blood bank?' re-checks that institution's live records", async () => {
    const operational = {
      facilities: [{ index: 0, name: bankName, type: "BLOOD_BANK", address: "Integration test site", phone: null, distanceKm: 1, latitude: null, longitude: null, directionsUrl: null, source: "LIFELINK", hadInventory: false, raw: { id: `lifelink:${bankId}`, source: "LIFELINK" } }],
      category: "blood" as const, center: null, selectedIndex: 0, renderable: true, provider: "LIFELINK",
    };
    const result = await assistant.generateAssistantResponse({ message: "Is O-positive blood available at that blood bank?", actor: actor(donorId), history: [], operational });
    assert.equal(result.intent, "LIVE_INVENTORY");
    assert.equal(result.liveDataUsed, true);
    assert.equal(result.display, "inventory");
    const records = result.data?.candidates as Array<{ group: string; unitsAvailable: number; institution: string }>;
    assert.deepEqual(records.map((record) => [record.group, record.unitsAvailable, record.institution]), [["O+", 7, bankName]]);
  });
});

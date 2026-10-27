import assert from "node:assert/strict";
import test from "node:test";
import { classifyQueryIntent, isUrgentBloodRequest } from "../../packages/rag/src/intent";
import { assessEmergency, buildEmergencyAnswer } from "../../apps/api/src/modules/rag/emergency";
import { extractOperationalContext, planAssistantRoute, referencedListIndex, splitHybridRequest, type OperationalContext } from "../../apps/api/src/modules/rag/routing";
import { generateAssistantResponse, isUrgentOrganAssistance } from "../../apps/api/src/modules/rag/orchestrator";
import { clearFacilityDiscoveryCacheForTests } from "../../apps/api/src/modules/maps/facility-discovery.service";
import { parseBloodGroup } from "../../apps/api/src/modules/rag/live-context";
import { inferAutoFacilityCategory } from "../../apps/web/components/assistant/facility-auto-discovery";
import { looksLikeEmergencyOffline } from "../../apps/web/components/assistant/offline-emergency";
import type { AuthContext } from "../../apps/api/src/middleware/auth";

// FR coverage: assistant routing (UT-RT), emergency safety (UT-EM), conversation context (UT-CTX),
// RAG and provider failure states (UT-RAG), hybrid requests (UT-HY), structured UI output (UT-UI).
// Every provider is mocked; nothing here calls Gemini, Supabase, Nominatim, Overpass, or a database.

const user: AuthContext = { userId: "user-1", role: "USER", principalType: "USER" };

interface Chunk { source_key: string; title: string; content: string }
interface Captured { generations: Array<{ system: string; prompt: string }>; classifierCalls: number; urls: string[] }

async function withMockedServices(
  options: { intent?: string; chunks?: Chunk[]; rpcStatus?: number; generation?: string; overpass?: unknown[] },
  run: (captured: Captured) => Promise<void>,
) {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY", "OVERPASS_API_URL"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "supabase-secret-value-for-tests";
  process.env.GEMINI_API_KEY = "gemini-secret-value-for-tests";
  if (options.overpass) process.env.OVERPASS_API_URL = "https://overpass.mock.invalid/api";
  else delete process.env.OVERPASS_API_URL;
  const captured: Captured = { generations: [], classifierCalls: 0, urls: [] };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    captured.urls.push(url);
    const raw = String(init?.body ?? "");
    if (url.includes(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(0.02) } });
    if (url.includes("/rpc/")) {
      if (options.rpcStatus) return new Response("unavailable", { status: options.rpcStatus });
      return Response.json((options.chunks ?? []).map((chunk, index) => ({ id: `chunk-${index}`, source_type: "FAQ", similarity: 0.88, metadata: {}, ...chunk })));
    }
    if (url.includes("overpass.mock.invalid")) return Response.json({ elements: options.overpass ?? [] });
    if (url.includes(":generateContent")) {
      const body = JSON.parse(raw);
      const system: string = body.systemInstruction?.parts?.[0]?.text ?? "";
      if (system.startsWith("Classify the current user")) {
        captured.classifierCalls += 1;
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: options.intent ?? "KNOWLEDGE" }) }] } }] });
      }
      captured.generations.push({ system, prompt: body.contents?.[0]?.parts?.[0]?.text ?? "" });
      return Response.json({ candidates: [{ content: { parts: [{ text: options.generation ?? "Grounded answer [S1]." }] } }] });
    }
    return Response.json([]);
  };
  try {
    await run(captured);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function noNetwork() {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("This path must not use the network"); };
  return { calls: () => calls, restore: () => { globalThis.fetch = previousFetch; } };
}

const storedBloodSearch: OperationalContext = {
  facilities: [
    { index: 0, name: "City Blood Centre", type: "BLOOD_BANK", address: "MG Road", phone: "+91 731 400 0000", distanceKm: 2.4, latitude: 22.72, longitude: 75.86, directionsUrl: "https://www.openstreetmap.org/directions?to=22.72%2C75.86", source: "LIFELINK", hadInventory: true, raw: { id: "lifelink:a", name: "City Blood Centre", source: "LIFELINK" } },
    { index: 1, name: "Lake View Blood Bank", type: "BLOOD_BANK", address: "Address not listed", phone: null, distanceKm: 6.1, latitude: 22.70, longitude: 75.90, directionsUrl: null, source: "OPENSTREETMAP", hadInventory: false, raw: { id: "osm:node:2", name: "Lake View Blood Bank", source: "OPENSTREETMAP" } },
  ],
  category: "blood",
  center: { latitude: 22.719, longitude: 75.857, displayName: "Indore" },
  selectedIndex: null,
  renderable: true,
  provider: "OPENSTREETMAP",
};

test("UT-RT-01 deterministic routing sends each kind of request to the right capability", () => {
  const cases: Array<[string, string]> = [
    ["Hi.", "GREETING"],
    ["What can you help me with?", "GENERAL_CONVERSATION"],
    ["Can you explain that more simply?", "GENERAL_CONVERSATION"],
    ["What is the process of organ donation?", "KNOWLEDGE"],
    ["What documents are needed for registration?", "KNOWLEDGE"],
    ["Is O-positive blood available?", "LIVE_INVENTORY"],
    ["Show me the available blood inventory.", "LIVE_INVENTORY"],
    ["Where can I check blood availability?", "LIVE_INVENTORY"],
    ["What is the current status of my donation request?", "REQUEST_STATUS"],
    ["Which institutions are registered on LifeLink?", "FACILITY_DISCOVERY"],
    ["Find hospitals near me.", "FACILITY_DISCOVERY"],
    ["Can you suggest a clinic?", "FACILITY_DISCOVERY"],
    ["Where is the nearest pharmacy?", "FACILITY_DISCOVERY"],
    ["I need a doctor.", "FACILITY_DISCOVERY"],
    ["I think I should see a doctor.", "FACILITY_DISCOVERY"],
    ["Can you help me find medical care?", "FACILITY_DISCOVERY"],
    ["Where can I get checked?", "FACILITY_DISCOVERY"],
    ["I need to visit a clinic.", "FACILITY_DISCOVERY"],
    ["What does a doctor do?", "KNOWLEDGE"],
    ["How do I update blood inventory?", "KNOWLEDGE"],
    ["How do institutions get registered on LifeLink?", "KNOWLEDGE"],
  ];
  for (const [message, intent] of cases) assert.equal(classifyQueryIntent(message), intent, message);
});

test("UT-RT-05 blood groups are parsed exactly, including hyphenated spellings (found in the browser check)", () => {
  const cases: Array<[string, string | null]> = [
    ["Is O-positive blood available?", "O_POSITIVE"], ["Is O-negative blood available?", "O_NEGATIVE"],
    ["Any AB-positive units?", "AB_POSITIVE"], ["need B- blood", "B_NEGATIVE"], ["A+ stock", "A_POSITIVE"],
    ["O −", "O_NEGATIVE"], ["B +ve blood", "B_POSITIVE"], ["a-ve", "A_NEGATIVE"], ["O pos", "O_POSITIVE"],
    ["Show me the available blood inventory", null],
  ];
  for (const [message, group] of cases) assert.equal(parseBloodGroup(message), group, message);
});

test("UT-RT-02 the route plan is a validated decision with explicit capability flags", () => {
  const discovery = planAssistantRoute("I think I need to see a doctor");
  assert.deepEqual(
    { intent: discovery.intent, needsFacility: discovery.needsFacility, needsRag: discovery.needsRag, needsClarification: discovery.needsClarification, category: discovery.facilityCategory },
    { intent: "FACILITY_DISCOVERY", needsFacility: true, needsRag: false, needsClarification: false, category: "care" },
  );
  const knowledge = planAssistantRoute("What does a doctor do?");
  assert.equal(knowledge.needsFacility, false);
  assert.equal(knowledge.needsRag, true);
  const inventory = planAssistantRoute("Is O-positive blood available?");
  assert.equal(inventory.needsLiveData, true);
  assert.equal(planAssistantRoute("I urgently need B+ blood").urgency, "URGENT");
  assert.equal(planAssistantRoute("He is not breathing").urgency, "CRITICAL");
});

test("UT-RT-03 hybrid requests are split into a knowledge part and a facility part", () => {
  assert.deepEqual(splitHybridRequest("Explain blood donation and find a nearby blood bank."), { knowledgeQuery: "Explain blood donation", facilityQuery: "find a nearby blood bank." });
  assert.deepEqual(splitHybridRequest("Find a hospital and explain what information I should bring."), { knowledgeQuery: "explain what information I should bring.", facilityQuery: "Find a hospital" });
  const organ = planAssistantRoute("Tell me how organ donation works and which registered centres are available.");
  assert.equal(organ.hybrid, true);
  assert.equal(organ.facilityCategory, "organ");
  assert.equal(splitHybridRequest("How does the blood request workflow work?"), null);
  assert.equal(splitHybridRequest("Find nearby blood donation centres in Indore"), null);
});

test("UT-RT-04 the model cannot turn an explanatory question into a facility search", async () => {
  await withMockedServices({ intent: "FACILITY_DISCOVERY", chunks: [{ source_key: "lifelink-faq", title: "FAQ", content: "Doctors assess and treat patients." }] }, async (captured) => {
    const result = await generateAssistantResponse({ message: "What does a doctor do?", actor: user, history: [] });
    assert.equal(result.intent, "KNOWLEDGE");
    assert.equal(result.data?.facilities, undefined);
    assert.equal(captured.generations.length, 1);
  });
});

test("UT-EM-01 emergency triage covers the critical categories and ignores study questions", () => {
  const emergencies: Array<[string, string]> = [
    ["My friend is bleeding heavily and it won't stop", "BLEEDING"],
    ["He collapsed and isn't responding", "UNCONSCIOUS"],
    ["She is not breathing", "BREATHING"],
    ["My father suddenly cannot speak clearly and one side of his face is drooping", "STROKE"],
    ["I think I'm having a heart attack", "CARDIAC"],
    ["My chest hurts badly and my left arm is numb", "CARDIAC"],
    ["He is having a seizure", "SEIZURE"],
    ["My son swallowed bleach", "POISONING"],
    ["He took too many sleeping pills", "POISONING"],
    ["There's been a bad car accident and he's badly hurt", "TRAUMA"],
    ["She got a severe burn from boiling oil", "BURN"],
    ["I want to kill myself", "SELF_HARM"],
  ];
  for (const [message, category] of emergencies) assert.equal(assessEmergency(message)?.category, category, message);
  for (const message of ["What are the warning signs of a stroke?", "What causes a heart attack?", "Explain what a seizure is", "What is severe bleeding?", "How do I treat a small cut?", "He is breathing normally now", "I hurt myself playing football", "I cut myself while cooking"]) {
    assert.equal(assessEmergency(message), null, message);
  }
});

test("UT-EM-02 the latest message decides; history only completes a referential follow-up", () => {
  assert.equal(assessEmergency("Now the bleeding is severe and won't stop", [{ role: "user", content: "I have a small cut" }])?.category, "BLEEDING");
  assert.equal(assessEmergency("It's getting worse now", [{ role: "user", content: "He is having a seizure" }])?.category, "SEIZURE");
  assert.equal(assessEmergency("Thanks, can you help me write an email?", [{ role: "user", content: "He collapsed" }]), null);
});

test("UT-EM-03 emergency answers are category-specific, include 112 with a manual-dial fallback, and need no services", async () => {
  const network = noNetwork();
  try {
    const stroke = await generateAssistantResponse({ message: "My mother's face is drooping and her speech became slurred", actor: user, history: [] });
    assert.equal(stroke.intent, "EMERGENCY");
    assert.match(stroke.answer, /112/);
    assert.match(stroke.answer, /dial 112 manually/);
    assert.match(stroke.answer, /time the symptoms started/);
    assert.equal(stroke.data?.emergencyCategory, "STROKE");
    assert.deepEqual(stroke.data?.emergency, { phoneNumber: "112", country: "IN", severity: "CRITICAL" });
    assert.deepEqual(stroke.suggestions, []);
    assert.equal(stroke.route?.urgency, "CRITICAL");
    const poisoning = buildEmergencyAnswer({ category: "POISONING" });
    assert.match(poisoning.answer, /Do not make the person vomit/);
    const selfHarm = buildEmergencyAnswer({ category: "SELF_HARM" });
    assert.match(selfHarm.answer, /112/);
    assert.match(selfHarm.answer, /14416/);
    assert.equal(network.calls(), 0);
  } finally { network.restore(); }
});

test("UT-CTX-01 follow-ups resolve against the stored list without new lookups or invented details", async () => {
  const network = noNetwork();
  try {
    const second = await generateAssistantResponse({ message: "Show me the second one again", actor: user, history: [], operational: storedBloodSearch });
    assert.equal(second.intent, "FACILITY_DISCOVERY");
    assert.match(second.answer, /Lake View Blood Bank/);
    assert.match(second.answer, /No phone number is listed/);
    assert.match(second.answer, /straight line/);
    assert.equal(second.data?.selectedFacilityId, "osm:node:2");
    assert.equal(second.data?.inventoryNotRechecked, true);
    assert.equal(second.route?.followUp, "SELECT");

    const contact = await generateAssistantResponse({ message: "What about its contact number?", actor: user, history: [], operational: { ...storedBloodSearch, selectedIndex: 0 } });
    assert.match(contact.answer, /\+91 731 400 0000/);
    assert.match(contact.answer, /haven’t re-checked stock/);

    const ambiguousContact = await generateAssistantResponse({ message: "What about its contact number?", actor: user, history: [], operational: storedBloodSearch });
    assert.match(ambiguousContact.answer, /City Blood Centre\*\* — \+91 731 400 0000/);
    assert.match(ambiguousContact.answer, /Lake View Blood Bank\*\* — no phone number listed/);

    const outOfRange = await generateAssistantResponse({ message: "Show me the fifth one", actor: user, history: [], operational: storedBloodSearch });
    assert.equal(outOfRange.status, "NEEDS_INPUT");
    assert.match(outOfRange.answer, /had 2 results/);

    const noContext = await generateAssistantResponse({ message: "Show me the second one again", actor: user, history: [] });
    assert.equal(noContext.status, "NEEDS_INPUT");
    assert.match(noContext.answer, /don’t have an earlier list/);
    assert.equal(network.calls(), 0);
  } finally { network.restore(); }
});

test("UT-CTX-02 a new care need is never hijacked by the previous blood or organ topic", async () => {
  assert.equal(planAssistantRoute("I think I need to see a doctor", [], storedBloodSearch).followUp, null);
  assert.equal(planAssistantRoute("I think I need to see a doctor", [], storedBloodSearch).facilityCategory, "care");
  const pharmacy = planAssistantRoute("Can you find a pharmacy near me?", [
    { role: "user", content: "Explain organ donation" }, { role: "assistant", content: "Organ donation is..." },
  ]);
  assert.equal(pharmacy.intent, "FACILITY_DISCOVERY");
  assert.equal(pharmacy.facilityCategory, "pharmacy");
  assert.equal(planAssistantRoute("Find a pharmacy in Vijay Nagar, Indore", [], storedBloodSearch).followUp, null, "a new location is a new search");

  // Found in the browser check: "need" in one turn and "blood" in the next must not combine into an urgent request.
  const afterDoctor = [{ role: "user" as const, content: "I think I need to see a doctor" }, { role: "assistant" as const, content: "Share a city or locality." }];
  assert.equal(isUrgentBloodRequest("Show me the available blood inventory", afterDoctor), false);
  assert.equal(planAssistantRoute("Show me the available blood inventory", afterDoctor).intent, "LIVE_INVENTORY");
  assert.equal(planAssistantRoute("Show me the available blood inventory", afterDoctor).urgency, "ROUTINE");
  const afterUrgent = [{ role: "user" as const, content: "My father urgently needs blood." }, { role: "assistant" as const, content: "Which blood group?" }];
  assert.equal(isUrgentBloodRequest("B+", afterUrgent), true, "a detail reply still continues the urgent request");
  assert.equal(isUrgentBloodRequest("What is the status of my request?", afterUrgent), false);
  assert.equal(isUrgentOrganAssistance("What is the status of my request?", [{ role: "user", content: "We urgently need a kidney transplant" }]), false);

  const network = noNetwork();
  try {
    const doctor = await generateAssistantResponse({
      message: "I think I need to see a doctor.", actor: user, operational: null,
      history: [{ role: "user", content: "Find nearby blood banks" }, { role: "assistant", content: "Here are blood banks." }],
    });
    assert.equal(doctor.intent, "FACILITY_DISCOVERY");
    assert.equal(doctor.data?.facilityCategory, "care");
    assert.doesNotMatch(doctor.answer, /blood/i);
  } finally { network.restore(); }
});

test("UT-CTX-03 operational context comes only from structured stored results", () => {
  const context = extractOperationalContext([
    { role: "user", content: "Find blood banks in Indore" } as never,
    { role: "assistant", result: { data: { facilities: [{ id: "lifelink:a", name: "City Blood Centre", source: "LIFELINK", phone: "0731 1234567", distanceKm: 2 }], center: { latitude: 22.7, longitude: 75.8 }, facilityCategory: "blood", facilityProvider: "OPENSTREETMAP" } } },
    { role: "assistant", result: { answer: "1. Some Hospital, phone 99999 99999", data: {} } },
  ]);
  assert.equal(context?.facilities.length, 1);
  assert.equal(context?.facilities[0].phone, "0731 1234567");
  assert.equal(context?.category, "blood");
  assert.equal(context?.renderable, true);
  const inventory = extractOperationalContext([{ role: "assistant", result: { data: { candidates: [{ institution: "Red Cross Bank", address: "Ring Road", contactNumber: null, distanceKm: null, unitsAvailable: 4 }] } } }]);
  assert.equal(inventory?.facilities[0].name, "Red Cross Bank");
  assert.equal(inventory?.facilities[0].hadInventory, true);
  assert.equal(inventory?.renderable, false);
  assert.equal(extractOperationalContext([{ role: "assistant", result: { answer: "Prose only" } }]), null);
  assert.equal(referencedListIndex("show me the last one", 5), 4);
  assert.equal(referencedListIndex("option 3", 5), 2);
  assert.equal(referencedListIndex("What's the first step to donate blood?", 5), null);
});

test("UT-CTX-04 'find something closer' re-runs the same search and ranks only by straight-line distance", async () => {
  clearFacilityDiscoveryCacheForTests();
  await withMockedServices({ overpass: [
    { type: "node", id: 11, lat: 22.74, lon: 75.88, tags: { name: "Far Blood Bank", healthcare: "blood_bank" } },
    { type: "node", id: 12, lat: 22.7195, lon: 75.8575, tags: { name: "Corner Blood Bank", healthcare: "blood_bank", phone: "+91 731 222 3333" } },
  ] }, async () => {
    const result = await generateAssistantResponse({ message: "Find something closer", actor: user, history: [], operational: storedBloodSearch });
    assert.equal(result.status, "ANSWERED");
    const names = (result.data?.facilities as Array<{ name: string }>).map((facility) => facility.name);
    assert.deepEqual(names, ["Corner Blood Bank", "Far Blood Bank"]);
    assert.match(result.answer, /straight-line distance/);
  });
  clearFacilityDiscoveryCacheForTests();
});

test("UT-RAG-01 retrieval failure, empty retrieval, and success are reported as different states", async () => {
  await withMockedServices({ rpcStatus: 503 }, async (captured) => {
    const result = await generateAssistantResponse({ message: "How does the blood request workflow work?", actor: user, history: [] });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.knowledgeUsed, false);
    assert.equal(captured.generations.length, 0, "no answer may be generated without retrieved evidence");
    assert.deepEqual(result.suggestions, []);
  });
  await withMockedServices({ chunks: [] }, async () => {
    const result = await generateAssistantResponse({ message: "How does the blood request workflow work?", actor: user, history: [] });
    assert.equal(result.status, "NO_RESULTS");
  });
  await withMockedServices({ chunks: [{ source_key: "blood-workflow", title: "Blood workflow", content: "Requests move from CREATED to FULFILLED." }] }, async () => {
    const result = await generateAssistantResponse({ message: "How does the blood request workflow work?", actor: user, history: [] });
    assert.equal(result.status, "ANSWERED");
    assert.equal(result.sources[0].sourceKey, "blood-workflow");
    assert.ok(result.suggestions?.includes("Find a nearby blood bank"));
  });
});

test("UT-HY-01 a hybrid request answers from documents and runs facility discovery in one reply", async () => {
  await withMockedServices({ chunks: [{ source_key: "blood-donation-faq", title: "Blood donation FAQ", content: "Donors are screened before donating." }] }, async (captured) => {
    const result = await generateAssistantResponse({ message: "Explain blood donation and find a nearby blood bank.", actor: user, history: [] });
    assert.equal(result.intent, "FACILITY_DISCOVERY");
    assert.equal(result.knowledgeUsed, true);
    assert.equal(result.sources[0].sourceKey, "blood-donation-faq");
    assert.match(result.answer, /Grounded answer/);
    assert.match(result.answer, /Finding a blood bank/);
    assert.equal(result.status, "NEEDS_INPUT", "no location was given, so the facility part asks for one");
    assert.equal(result.data?.facilityCategory, "blood");
    assert.equal(result.route?.hybrid, true);
    assert.match(captured.generations[0].prompt, /do not list, name, or invent facilities/);
  });
});

test("UT-UI-01 capability answers are deterministic and suggestions are user prompts the router handles", async () => {
  const network = noNetwork();
  try {
    const result = await generateAssistantResponse({ message: "What can you help me with?", actor: user, history: [] });
    assert.match(result.answer, /can’t diagnose/);
    assert.equal(network.calls(), 0);
    for (const suggestion of result.suggestions ?? []) assert.notEqual(classifyQueryIntent(suggestion), "UNKNOWN", suggestion);
  } finally { network.restore(); }
});

test("UT-UI-02 the client uses the server's facility category and keeps an offline 112 fallback", () => {
  const result = (intent: string, data: Record<string, unknown> = {}) => ({ answer: "", intent, knowledgeUsed: false, liveDataUsed: false, sources: [], limitations: [], data });
  assert.equal(inferAutoFacilityCategory("Where can I get checked?", result("FACILITY_DISCOVERY", { facilityCategory: "care" })), "care");
  assert.equal(inferAutoFacilityCategory("Explain blood donation and find a nearby blood bank", result("FACILITY_DISCOVERY", { facilityCategory: "blood" })), "blood");
  assert.equal(inferAutoFacilityCategory("Which institutions are registered?", result("FACILITY_DISCOVERY", { facilities: [], directory: true })), null);
  assert.equal(looksLikeEmergencyOffline("He collapsed and isn't breathing"), true);
  assert.equal(looksLikeEmergencyOffline("What are the signs of a stroke?"), false);
});

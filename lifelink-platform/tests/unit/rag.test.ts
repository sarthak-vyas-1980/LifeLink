import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { classifyQueryIntent, isUrgentBloodRequest, understandQueryIntent } from "../../packages/rag/src/intent";
import { buildChunkInputs, chunkDocument, extractPdfPages, loadApprovedKnowledgeSources } from "../../packages/rag/src/knowledge-sources";
import { extractLocationQuery, extractUrgentBloodDetails, formatUrgentBloodAssistance } from "../../apps/api/src/modules/rag/live-context";
import { detectEmergencySeverity, generateAssistantResponse, isUrgentOrganAssistance, needsPromptInjuryAssessment } from "../../apps/api/src/modules/rag/orchestrator";
import { assistantConversationOwnerWhere } from "../../apps/api/src/modules/rag/conversations";
import { buildOverpassQueryForTests, dedupeFacilities, fetchOverpassPlaces, isFacilityDiscoveryConfigured, mapExternalPlace, rankFacilities, searchDiscoveredFacilities } from "../../apps/api/src/modules/maps/facility-discovery.service";
import { indexKnowledgeSource, isKnowledgeSourceUnchanged } from "../../packages/rag/src/indexing";
import { getFacilitySearchState } from "../../apps/web/components/assistant/facility-search-state";
import { buildAssistantHistory, isConversationNearBottom, shouldSendOnAssistantEnter } from "../../apps/web/components/assistant/conversation-behavior";
import { readAssistantConversation, writeAssistantConversation, assistantConversationStorageKey, type ConversationStorage } from "../../apps/web/lib/assistant-conversation-store";
import { hasMeasurableMapSize, isValidMapCoordinates } from "../../apps/web/components/map/map-layout";
import { readLocationPermission, requestFreshCoordinates } from "../../apps/web/components/assistant/location-manager";
import { inferAutoFacilityCategory } from "../../apps/web/components/assistant/facility-auto-discovery";

test("RAG intent classification separates platform instructions from live data", () => {
  assert.equal(classifyQueryIntent("How does the blood request workflow work?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("How do I submit a blood request?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("What is the meaning of Reserved status?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("What is the status of my request?"), "REQUEST_STATUS");
  assert.equal(classifyQueryIntent("What is the current inventory for O+?"), "LIVE_INVENTORY");
  assert.equal(classifyQueryIntent("Check current inventory for O+"), "LIVE_INVENTORY");
  assert.equal(classifyQueryIntent("Find nearby blood donation centres in Indore"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Find hospitals in Bhawarkua, Indore"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Show emergency departments near me"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Find a pharmacy near me"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Show clinics near my locality"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("I think I need to see a doctor"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("I need to see a doctor"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Cancel my blood request"), "WORKFLOW_ACTION");
  assert.equal(classifyQueryIntent("Should I take medicine for chest pain?"), "MEDICAL_OR_CLINICAL");
});

test("medical education questions use medical intent while preserving emergency intent", () => {
  assert.equal(classifyQueryIntent("What is asthma?"), "MEDICAL_OR_CLINICAL");
  assert.equal(classifyQueryIntent("What is leukemia?"), "MEDICAL_OR_CLINICAL");
  assert.equal(classifyQueryIntent("What is the current inventory for O+?"), "LIVE_INVENTORY");
  assert.equal(classifyQueryIntent("How many donor profiles are included in the sample dataset?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("Can someone donate blood after recovering from an illness?"), "MEDICAL_OR_CLINICAL");
  assert.equal(classifyQueryIntent("How can I register as a donor on LifeLink?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("Please register me as a blood donor"), "WORKFLOW_ACTION");
  assert.equal(classifyQueryIntent("Hello!"), "GREETING");
  assert.equal(isUrgentOrganAssistance("We urgently need a kidney transplant", []), true);
  assert.equal(isUrgentOrganAssistance("How does organ transplant registration work?", []), false);
  assert.equal(isUrgentOrganAssistance("I think I need to see a doctor", [
    { role: "user", content: "We urgently need a kidney transplant." },
  ]), false);
});

test("Gemini intent understanding uses validated structured output and recent conversation context", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: "LIVE_INVENTORY" }) }] } }] });
  };
  try {
    const intent = await understandQueryIntent("Two units", [
      { role: "user", content: "I urgently need B+ blood in Indore." },
      { role: "assistant", content: "How many units did the treating team specify?" },
    ]);
    assert.equal(intent, "LIVE_INVENTORY");
    const contents = requestBody?.contents as Array<{ parts: Array<{ text: string }> }>;
    assert.match(contents[0].parts[0].text, /"Two units"/);
    assert.match(contents[0].parts[0].text, /B\+ blood in Indore/);
    const config = requestBody?.generationConfig as Record<string, unknown>;
    assert.equal(config.responseMimeType, "application/json");
    assert.ok(config.responseSchema);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("general-purpose requests avoid healthcare retrieval and receive a direct Gemini answer", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  let embedCalls = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> } };
    const classifier = body.systemInstruction?.parts?.[0]?.text?.startsWith("Classify the current user");
    if (classifier) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: "GENERAL_CONVERSATION" }) }] } }] });
    if (String(_input).includes(":embedContent")) { embedCalls += 1; throw new Error("retrieval should not run"); }
    return Response.json({ candidates: [{ content: { parts: [{ text: "The story begins as the old lighthouse wakes beneath a violet moon." }] } }] });
  };
  try {
    const result = await generateAssistantResponse({
      message: "Write a fantasy battle scene", actor: { role: "USER", principalType: "USER" }, history: [],
    });
    assert.equal(result.intent, "GENERAL_CONVERSATION");
    assert.equal(result.knowledgeUsed, false);
    assert.equal(result.sources.length, 0);
    assert.match(result.answer, /lighthouse/);
    assert.equal(embedCalls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("minor-injury messages use first-aid guidance with pharmacy, clinic, and emergency boundaries", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  let firstAidInstruction = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(0.01) } });
    if (url.includes("/rpc/")) return Response.json([]);
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> } };
      firstAidInstruction = body.systemInstruction?.parts?.[0]?.text ?? "";
      return Response.json({ candidates: [{ content: { parts: [{ text: "Rinse the small cut with clean water and cover it with a sterile dressing. A pharmacy can help with supplies; seek a clinic if it is deep or shows infection signs." }] } }] });
    }
    throw new Error("Unexpected mocked request");
  };
  try {
    const result = await generateAssistantResponse({
      message: "I cut my finger but the bleeding has stopped.", actor: { role: "USER", principalType: "USER" }, history: [],
    });
    assert.equal(result.intent, "FIRST_AID");
    assert.equal(result.liveDataUsed, false);
    assert.equal(result.knowledgeUsed, false);
    assert.match(result.answer, /sterile dressing/i);
    assert.match(firstAidInstruction, /pharmacy/i);
    assert.match(firstAidInstruction, /clinic/i);
    assert.match(firstAidInstruction, /emergency services/i);
    assert.match(firstAidInstruction, /instead of being automatically sent to a hospital/i);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("ordinary bicycle bruises receive first aid without critical-emergency escalation", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  let generationInstruction = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(0.01) } });
    if (url.includes("/rpc/")) return Response.json([]);
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> } };
      generationInstruction = body.systemInstruction?.parts?.[0]?.text ?? "";
      return Response.json({ candidates: [{ content: { parts: [{ text: "Rest and protect the bruises. Use a cold pack wrapped in cloth for short intervals and seek medical assessment if you cannot bear weight, have severe pain, or the swelling worsens." }] } }] });
    }
    throw new Error("Unexpected mocked request");
  };
  try {
    const result = await generateAssistantResponse({ message: "I fell off my bike and got bruises on my knees and elbow.", actor: { role: "USER", principalType: "USER" }, history: [] });
    assert.equal(result.intent, "FIRST_AID");
    assert.notEqual(result.intent, "EMERGENCY");
    assert.match(result.answer, /cold pack wrapped in cloth/i);
    assert.match(generationInstruction, /For a minor bruise/);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("deterministic emergency triage escalates new blood loss without inheriting stale urgency", () => {
  const minorHistory = [{ role: "user" as const, content: "I fell off my bike and bruised my knee." }, { role: "assistant" as const, content: "Rest and use a wrapped cold pack." }];
  assert.equal(detectEmergencySeverity("But I lost a lot of blood and think I need to be hospitalized.", minorHistory), true);
  for (const message of ["The bleeding won't stop.", "I am unconscious.", "I can't breathe.", "I have severe chest pain and sweating.", "My face is drooping and I suddenly can't speak clearly.", "I have a large deep burn.", "There was a major crash and I have a serious head injury."]) {
    assert.equal(detectEmergencySeverity(message), true, message);
  }
  assert.equal(detectEmergencySeverity("I fell off my bike and got bruises on my knees and elbow."), false);
  assert.equal(detectEmergencySeverity("What are the warning signs of severe bleeding?"), false);
  assert.equal(detectEmergencySeverity("Help me write a Python function.", [{ role: "user", content: "I lost a lot of blood." }]), false);
  assert.equal(detectEmergencySeverity("It is getting worse and the bleeding won't stop.", [{ role: "user", content: "I have a deep cut." }]), true);
});

test("critical emergency response is deterministic and exposes the fixed Indian 112 action data", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Emergency path must not wait on Gemini or retrieval"); };
  try {
    const result = await generateAssistantResponse({ message: "I lost a lot of blood after falling off my bike.", actor: { role: "USER", principalType: "USER" }, history: [] });
    assert.equal(result.intent, "EMERGENCY");
    assert.match(result.answer, /112/);
    assert.match(result.answer, /Do not drive yourself/i);
    assert.match(result.answer, /add more material without removing the first layer/i);
    assert.deepEqual(result.data?.emergency, { phoneNumber: "112", country: "IN", severity: "CRITICAL" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("injuries with inability to bear weight get prompt assessment rather than a pharmacy-only suggestion", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Prompt assessment route is deterministic"); };
  try {
    const text = "My knee is very swollen and I cannot put weight on it.";
    assert.equal(needsPromptInjuryAssessment(text), true);
    const result = await generateAssistantResponse({ message: text, actor: { role: "USER", principalType: "USER" }, history: [] });
    assert.equal(result.intent, "FIRST_AID");
    assert.match(result.answer, /prompt medical assessment today/i);
    assert.equal(result.data?.careRecommendation, "PROMPT_ASSESSMENT");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("routine doctor request routes to care discovery and does not inherit a previous blood workflow", async () => {
  const oldFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw new Error("A request without location must not call external providers"); };
  try {
    const result = await generateAssistantResponse({
      message: "I think I need to see a doctor.",
      actor: { role: "USER", principalType: "USER" },
      history: [
        { role: "user", content: "My father urgently needs B+ blood." },
        { role: "assistant", content: "What blood group and locality should I use?" },
      ],
    });
    assert.equal(result.intent, "FACILITY_DISCOVERY");
    assert.match(result.answer, /nearby healthcare facilities/i);
    assert.doesNotMatch(result.answer, /blood group|units|emergency services/i);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("server conversation owner scoping distinguishes users and institutions", () => {
  assert.deepEqual(assistantConversationOwnerWhere({ role: "USER", principalType: "USER", userId: "user-1" }), { ownerUserId: "user-1", ownerInstitutionId: null });
  assert.deepEqual(assistantConversationOwnerWhere({ role: "HOSPITAL_USER", principalType: "INSTITUTION", institutionId: "institution-1" }), { ownerUserId: null, ownerInstitutionId: "institution-1" });
  assert.throws(() => assistantConversationOwnerWhere({ role: "USER", principalType: "USER" }), /Authentication required/);
});

test("urgent blood requests are recognized across natural phrasings and follow-up turns", () => {
  for (const message of [
    "I urgently need B+ blood.",
    "My father needs two units of blood.",
    "I need blood near Limbodi, Indore.",
    "A patient needs blood immediately.",
    "Which nearby blood banks have the required blood group?",
  ]) assert.equal(isUrgentBloodRequest(message), true, message);
  assert.equal(classifyQueryIntent("I urgently need B+ blood."), "LIVE_INVENTORY");
  assert.equal(isUrgentBloodRequest("How do I request blood through LifeLink?"), false);
  assert.equal(isUrgentBloodRequest("near Limbodi, Indore", [
    { role: "user", content: "My father urgently needs B+ blood." },
    { role: "assistant", content: "Which locality?" },
  ]), true);
  assert.equal(isUrgentBloodRequest("How do I read the workflow?", [
    { role: "user", content: "I urgently need B+ blood." },
    { role: "assistant", content: "Nothing has been created by this chat. Open the authenticated blood request form." },
  ]), false);
  assert.equal(isUrgentBloodRequest("I think I need to see a doctor", [
    { role: "user", content: "My father urgently needs B+ blood." },
    { role: "assistant", content: "What blood group and locality should I use?" },
  ]), false, "a new care-seeking turn must not inherit an earlier blood request");
});

test("urgent blood detail extraction carries supplied group, component, units, and locality forward", () => {
  const details = extractUrgentBloodDetails("I live in Limbodi, Indore.", [
    { role: "user", content: "My father needs two units of B+ platelets." },
    { role: "assistant", content: "Which locality?" },
  ]);
  assert.deepEqual(details, {
    bloodGroup: "B_POSITIVE", component: "PLATELETS", units: 2, location: "Limbodi, Indore, India",
  });
  const partial = extractUrgentBloodDetails("I urgently need blood.");
  assert.equal(partial.bloodGroup, undefined);
  assert.equal(partial.location, undefined);
  assert.equal(partial.component, undefined);
  assert.equal(partial.units, undefined);
  const answeredPrompts = extractUrgentBloodDetails("B+ and Limbodi, Indore", [
    { role: "user", content: "I urgently need blood." },
    { role: "assistant", content: "What blood group and city/locality or landmark should I use?" },
  ]);
  assert.equal(answeredPrompts.bloodGroup, "B_POSITIVE");
  assert.equal(answeredPrompts.location, "Limbodi, Indore, India");
  const quantityReply = extractUrgentBloodDetails("Plasma and 2", [
    { role: "user", content: "I urgently need B+ blood near Indore." },
    { role: "assistant", content: "Which component and how many units did the treating team specify?" },
  ]);
  assert.equal(quantityReply.component, "PLASMA");
  assert.equal(quantityReply.units, 2);
});

test("facility discovery builds bounded OpenStreetMap queries and handles provider setup and failures", async () => {
  const original = process.env.OVERPASS_API_URL;
  delete process.env.OVERPASS_API_URL;
  assert.equal(isFacilityDiscoveryConfigured(), false);
  assert.deepEqual(await fetchOverpassPlaces("blood", { latitude: 22.7, longitude: 75.9 }, 25), { places: [], error: "NOT_CONFIGURED" });
  const query = buildOverpassQueryForTests("blood", 22.7, 75.9, 25_000);
  assert.match(query, /around:25000,22\.7,75\.9/);
  assert.match(query, /blood_bank/);
  assert.match(buildOverpassQueryForTests("emergency", 22.7, 75.9, 25_000), /amenity.*hospital/);
  assert.match(buildOverpassQueryForTests("care", 22.7, 75.9, 25_000), /amenity.*clinic/);
  assert.match(buildOverpassQueryForTests("care", 22.7, 75.9, 25_000), /amenity.*hospital/);

  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ elements: [{ type: "node", id: 4, lat: 22.7, lon: 75.9, tags: { name: "City Blood Centre", healthcare: "blood_bank" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal((await fetchOverpassPlaces("blood", { latitude: 22.7, longitude: 75.9 }, 10, "https://mock.invalid/overpass", fetcher)).places.length, 1);
  const timeoutFetch: typeof fetch = async () => { throw new Error("aborted"); };
  assert.deepEqual(await fetchOverpassPlaces("blood", { latitude: 22.7, longitude: 75.9 }, 10, "https://mock.invalid/overpass", timeoutFetch), { places: [], error: "LOOKUP_FAILED" });
  const rateLimitedFetch: typeof fetch = async () => new Response("Too many requests", { status: 429 });
  assert.deepEqual(await fetchOverpassPlaces("care", { latitude: 22.7, longitude: 75.9 }, 10, "https://mock.invalid/overpass", rateLimitedFetch), { places: [], error: "RATE_LIMITED" });
  if (original === undefined) delete process.env.OVERPASS_API_URL; else process.env.OVERPASS_API_URL = original;
});

test("facility ranking prioritizes care fit and verified emergency capability before distance", () => {
  const center = { latitude: 22.7, longitude: 75.9 };
  const clinic = mapExternalPlace({ type: "node", id: 41, lat: 22.72, lon: 75.9, tags: { name: "Nearby Clinic", amenity: "clinic" } }, "care", center)!;
  const hospital = mapExternalPlace({ type: "node", id: 42, lat: 22.7001, lon: 75.9, tags: { name: "Closer Hospital", amenity: "hospital" } }, "care", center)!;
  const rankedCare = rankFacilities([hospital, clinic], "care");
  assert.deepEqual(rankedCare.map((facility) => facility.type), ["CLINIC", "HOSPITAL"]);
  const unknownHospital = { ...hospital, emergencyServiceStatus: "UNKNOWN" as const };
  const verifiedHospital = { ...hospital, id: "lifelink:verified", emergencyServiceStatus: "REGISTERED" as const, source: "LIFELINK" as const, verification: "REGISTERED_ACTIVE" as const, distanceKm: 8 };
  assert.deepEqual(rankFacilities([unknownHospital, verifiedHospital], "hospital").map((facility) => facility.id), ["lifelink:verified", hospital.id]);
});

test("location manager reads permission state and always requests fresh, validated coordinates", async () => {
  const permissions = (state: PermissionState) => ({ query: async () => ({ state }) }) as unknown as Permissions;
  assert.equal(await readLocationPermission(permissions("granted")), "granted");
  assert.equal(await readLocationPermission(permissions("prompt")), "prompt");
  assert.equal(await readLocationPermission(permissions("denied")), "denied");
  assert.equal(await readLocationPermission(undefined), "unsupported");
  let receivedOptions: PositionOptions | undefined;
  const geolocation = { getCurrentPosition: (success: PositionCallback, _error: PositionErrorCallback, options?: PositionOptions) => {
    receivedOptions = options;
    success({ coords: { latitude: 22.7, longitude: 75.9 } } as GeolocationPosition);
  } } as Geolocation;
  assert.deepEqual(await requestFreshCoordinates(geolocation), { latitude: 22.7, longitude: 75.9 });
  assert.equal(receivedOptions?.maximumAge, 0);
  const denied = { getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => error({ code: 1 } as GeolocationPositionError) } as Geolocation;
  await assert.rejects(requestFreshCoordinates(denied), /LOCATION_DENIED/);
  const timedOut = { getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => error({ code: 3 } as GeolocationPositionError) } as Geolocation;
  await assert.rejects(requestFreshCoordinates(timedOut), /LOCATION_TIMEOUT/);
});

test("automatic discovery chooses relevant categories only for newly returned care or facility needs", () => {
  const result = (intent: string, data: Record<string, unknown> = {}, answer = "") => ({ answer, intent, knowledgeUsed: false, liveDataUsed: false, sources: [], limitations: [], data });
  assert.equal(inferAutoFacilityCategory("Heavy bleeding", result("EMERGENCY", { emergency: { severity: "CRITICAL" } })), "emergency");
  assert.equal(inferAutoFacilityCategory("I cannot bear weight", result("FIRST_AID", { careRecommendation: "PROMPT_ASSESSMENT" })), "hospital");
  assert.equal(inferAutoFacilityCategory("Find a pharmacy near me", result("FACILITY_DISCOVERY")), "pharmacy");
  assert.equal(inferAutoFacilityCategory("I think I need to see a doctor", result("FACILITY_DISCOVERY")), "care");
  assert.equal(inferAutoFacilityCategory("I cut my finger", result("FIRST_AID", {}, "Clean and cover it; a pharmacy can help with sterile dressing supplies.")), "pharmacy");
  assert.equal(inferAutoFacilityCategory("Explain blood donation", result("KNOWLEDGE")), null);
  assert.equal(inferAutoFacilityCategory("Heavy bleeding", result("EMERGENCY", { facilities: [] })), null);
});

test("assistant facility panel distinguishes loading, empty, error, and results states", () => {
  assert.equal(getFacilitySearchState({ loading: false, error: "", searched: false, resultCount: 0 }), "idle");
  assert.equal(getFacilitySearchState({ loading: true, error: "", searched: false, resultCount: 0 }), "loading");
  assert.equal(getFacilitySearchState({ loading: false, error: "Offline", searched: false, resultCount: 0 }), "error");
  assert.equal(getFacilitySearchState({ loading: false, error: "", searched: true, resultCount: 0 }), "empty");
  assert.equal(getFacilitySearchState({ loading: false, error: "", searched: true, resultCount: 1 }), "results");
});

test("assistant conversation state is user-scoped, refresh-safe, and restores structured results once", () => {
  const values = new Map<string, string>();
  const storage: ConversationStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const snapshot = {
    ownerId: "account-a", conversationId: "thread-stable", updatedAt: 1_000,
    draft: "I need two units",
    messages: [
      { id: "u1", role: "user" as const, content: "I urgently need B+ blood in Bhawarkua, Indore.", deliveryStatus: "sending" as const },
      { id: "a1", role: "assistant" as const, content: "Nearby hospitals and blood banks.", result: { answer: "Nearby hospitals and blood banks.", intent: "LIVE_INVENTORY", knowledgeUsed: false, liveDataUsed: false, sources: [], limitations: [], data: { facilities: [{ id: "osm:node:1", name: "External listing" }] } } },
    ],
  };
  assert.equal(writeAssistantConversation(storage, snapshot), true);
  const restored = readAssistantConversation(storage, "account-a", 2_000);
  assert.equal(restored?.conversationId, "thread-stable");
  assert.equal(restored?.messages.length, 2, "restoring a snapshot must not append duplicate messages");
  assert.equal(restored?.messages[0].failed, true, "an in-flight send becomes recoverable after refresh");
  assert.match(restored?.messages[0].errorMessage ?? "", /retry/i);
  assert.deepEqual(restored?.messages[1].result?.data?.facilities, [{ id: "osm:node:1", name: "External listing" }]);
  assert.equal(restored?.draft, "I need two units");
  assert.equal(readAssistantConversation(storage, "account-b", 2_000), null, "another signed-in user must not restore this conversation");
  assert.notEqual(assistantConversationStorageKey("account-a"), assistantConversationStorageKey("account-b"));
  assert.equal(readAssistantConversation(storage, "account-a", 1_000 + 8 * 24 * 60 * 60 * 1000), null, "expired tab-session data should be removed");
});

test("assistant follow-ups send recent context without failed or retried duplicate turns", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" as const : "user" as const, content: `turn ${index}` }));
  messages.push({ id: "failed", role: "user", content: "failed turn", failed: true } as typeof messages[number]);
  const history = buildAssistantHistory(messages, "m8");
  assert.equal(history.length, 8);
  assert.ok(history.every((item) => item.content !== "failed turn" && item.content !== "turn 8"));
  assert.equal(history.at(-1)?.content, "turn 9");
});

test("chat keyboard, scroll anchoring, and map initialization use their layout states", () => {
  assert.equal(shouldSendOnAssistantEnter("Enter", false, false), true);
  assert.equal(shouldSendOnAssistantEnter("Enter", true, false), false);
  assert.equal(shouldSendOnAssistantEnter("Enter", false, true), false);
  assert.equal(isConversationNearBottom(1000, 880, 100), true);
  assert.equal(isConversationNearBottom(1600, 400, 600), false);
  assert.equal(hasMeasurableMapSize(0, 220), false);
  assert.equal(hasMeasurableMapSize(320, 220), true);
  assert.equal(isValidMapCoordinates([22.7, 75.9]), true);
  assert.equal(isValidMapCoordinates([91, 75.9]), false);
  assert.equal(isValidMapCoordinates([22.7, Number.NaN]), false);
  assert.equal(isValidMapCoordinates([null, 75.9]), false);
});

test("external facility results are map-ready, unverified, and never inventory evidence", () => {
  const facility = mapExternalPlace({ type: "way", id: 12, center: { lat: 22.71, lon: 75.91 }, tags: { name: "City Blood Centre", healthcare: "blood_bank", phone: "+91 12345" } }, "blood", { latitude: 22.7, longitude: 75.9 });
  assert.ok(facility);
  assert.equal(facility?.source, "OPENSTREETMAP");
  assert.equal(facility?.verification, "EXTERNAL_LISTING");
  assert.equal(facility?.inventory.status, "NOT_FOUND");
  assert.equal(facility?.latitude, 22.71);
  assert.equal(facility?.longitude, 75.91);
  assert.equal(facility?.phone, "+91 12345");
  assert.match(facility?.sourceUrl ?? "", /openstreetmap\.org\/way\/12/);
  assert.equal(mapExternalPlace({ type: "node", id: 13, lat: 22.7, lon: 75.9, tags: { healthcare: "blood_bank" } }, "blood", { latitude: 22.7, longitude: 75.9 }), null);
  assert.equal(mapExternalPlace({ type: "node", id: 14, lat: 91, lon: 75.9, tags: { name: "Invalid", healthcare: "blood_bank" } }, "blood", { latitude: 22.7, longitude: 75.9 }), null);
});

test("OpenStreetMap healthcare tags classify hospital, clinic, pharmacy, and unknown facilities separately", () => {
  const center = { latitude: 22.7, longitude: 75.9 };
  const map = (id: number, tags: Record<string, string>) => mapExternalPlace({ type: "node", id, lat: 22.7, lon: 75.9, tags }, "all", center);
  assert.equal(map(101, { name: "Hospital", amenity: "hospital" })?.type, "HOSPITAL");
  assert.equal(map(102, { name: "Clinic", amenity: "clinic" })?.type, "CLINIC");
  assert.equal(map(103, { name: "Doctor", amenity: "doctors" })?.type, "CLINIC");
  assert.equal(map(104, { name: "Medical Store", amenity: "pharmacy" })?.type, "PHARMACY");
  assert.equal(map(105, { name: "Community Health", healthcare: "social_facility" })?.type, "OTHER_HEALTHCARE_FACILITY");
  assert.equal(mapExternalPlace({ type: "node", id: 106, lat: 22.7, lon: 75.9, tags: { name: "Clinic" } }, "clinic", center), null);
  assert.equal(map(107, { name: "ED", healthcare: "emergency_department" })?.emergencyServiceStatus, "LISTED");
  assert.equal(map(108, { name: "Unsafe phone", amenity: "pharmacy", phone: "javascript:alert(1)" })?.phone, null);
  const query = buildOverpassQueryForTests("all", 22.7, 75.9, 1000);
  assert.match(query, /amenity.*clinic/);
  assert.match(query, /amenity.*pharmacy/);
});

test("facility discovery handles failed geocoding without inventing coordinates", async () => {
  const oldEndpoint = process.env.GEOCODING_ENDPOINT;
  const oldFetch = globalThis.fetch;
  process.env.GEOCODING_ENDPOINT = "https://mock.invalid/geocode";
  globalThis.fetch = async () => { throw new Error("provider unavailable"); };
  try {
    const result = await searchDiscoveredFacilities({ location: "No Such Locality, Example City", category: "hospital", radiusKm: 10 });
    assert.equal(result.center, null);
    assert.equal(result.facilities.length, 0);
    assert.equal(result.unavailableReason, "LOCATION_UNAVAILABLE");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldEndpoint === undefined) delete process.env.GEOCODING_ENDPOINT; else process.env.GEOCODING_ENDPOINT = oldEndpoint;
  }
});

test("LifeLink and external facility entries are deduplicated while preserving verified source", () => {
  const internal = mapExternalPlace({ type: "node", id: 20, lat: 22.7, lon: 75.9, tags: { name: "Central Hospital", amenity: "hospital" } }, "hospital", { latitude: 22.7, longitude: 75.9 })!;
  const registered = { ...internal, id: "lifelink:abc", source: "LIFELINK" as const, verification: "REGISTERED_ACTIVE" as const, phone: "111", inventory: { status: "CONFIRMED" as const, bloodGroup: "B_POSITIVE", units: 2, updatedAt: new Date().toISOString() } };
  const external = { ...internal, id: "osm:node:20", phone: null, inventory: { status: "NOT_FOUND" as const } };
  const result = dedupeFacilities([registered], [external], 25);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "LIFELINK");
  assert.equal(result[0].inventory.status, "CONFIRMED");
});

test("urgent assistance prioritizes mocked verified stock, labels unknown stock, and hands off only when ready", () => {
  const now = Date.now();
  const facilities = [
    { id: "near", name: "Nearby Blood Bank", address: "Limbodi, Indore", contactNumber: "+910000000001", latitude: 22.6, longitude: 75.8 },
    { id: "unknown", name: "Registered Hospital", address: "Indore", contactNumber: "+910000000002", latitude: 22.61, longitude: 75.81 },
  ];
  const result = formatUrgentBloodAssistance({
    details: { bloodGroup: "B_POSITIVE", component: "PLATELETS", units: 2, location: "Limbodi, Indore" },
    facilities,
    inventory: [{ institutionId: "near", bloodGroup: "B_POSITIVE", component: "PLATELETS", unitsAvailable: 3, lastUpdated: new Date(now - 60_000) }],
    coordinates: { latitude: 22.6, longitude: 75.8 },
    actorCanCreateRequest: true,
    now,
  });
  assert.ok(result.answer.indexOf("I’m sorry this is urgent") < result.answer.indexOf("Recent matching inventory records"));
  assert.match(result.answer, /Nearby Blood Bank.*3 unit\(s\) recorded/s);
  assert.match(result.answer, /Registered Hospital.*stock is unknown|Registered Hospital/s);
  assert.match(result.answer, /matching stock is unknown or unverified/);
  assert.match(result.answer, /nothing has been created by this chat/i);
  assert.equal(result.handoff?.href, "/requests");

  const stale = formatUrgentBloodAssistance({
    details: { bloodGroup: "B_POSITIVE", location: "Limbodi, Indore" }, facilities: [facilities[0]],
    inventory: [{ institutionId: "near", bloodGroup: "B_POSITIVE", component: "PLATELETS", unitsAvailable: 3, lastUpdated: new Date(now - 3 * 24 * 60 * 60 * 1000) }],
    coordinates: { latitude: 22.6, longitude: 75.8 }, now,
  });
  assert.match(stale.answer, /too old to confirm/i);

  const partial = formatUrgentBloodAssistance({
    details: { bloodGroup: "B_POSITIVE", location: "Limbodi, Indore" },
    facilities, inventory: [], coordinates: { latitude: 22.6, longitude: 75.8 }, actorCanCreateRequest: true,
  });
  assert.match(partial.answer, /component specified by the care team and number of units/i);
  assert.equal(partial.handoff?.href, "/map");
});

test("urgent assistance fails closed on live-service errors and never substitutes sample fixtures", () => {
  const result = formatUrgentBloodAssistance({
    details: { bloodGroup: "B_POSITIVE", location: "Limbodi, Indore" },
    facilities: [], inventory: [], inventoryAvailable: false, facilityLookupAvailable: false,
    actorCanCreateRequest: false,
  });
  assert.equal(result.liveDataUsed, false);
  assert.match(result.answer, /couldn’t retrieve registered facility contacts/i);
  assert.match(result.answer, /stock status is unknown/i);
  assert.doesNotMatch(result.answer, /synthetic|fictional|sample dataset/i);
  assert.equal(result.handoff?.href, "/map");
});

test("approved PDFs extract page-level text and produce page-aware chunks", async () => {
  const root = process.cwd();
  const medical = await extractPdfPages(path.join(root, "docs/pdf-knowledge/Medical_book.pdf"));
  const sample = await extractPdfPages(path.join(root, "docs/pdf-knowledge/LifeLink_Sample_Data_and_Test_Fixtures(1).pdf"));
  assert.equal(medical.length, 636);
  assert.equal(sample.length, 50);
  assert.match(sample[0].content, /fictional test fixtures/i);

  const sources = await loadApprovedKnowledgeSources(root);
  const medicalSource = sources.find(({ definition }) => definition.sourceKey === "medical-encyclopedia");
  const sampleSource = sources.find(({ definition }) => definition.sourceKey === "lifelink-sample-data");
  assert.ok(medicalSource?.pages?.length);
  assert.ok(sampleSource?.pages?.length);
  for (const source of [medicalSource!, sampleSource!]) {
    const chunks = buildChunkInputs(source);
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => chunk.pageNumbers?.length === 1));
    assert.ok(chunks.every((chunk) => chunk.sourceKey === source.definition.sourceKey));
    assert.ok(chunks.every((chunk) => chunk.relativePath === source.definition.relativePath && chunk.version === source.checksum));
    assert.equal(source.checksum, createHash("sha256").update(await readFile(source.absolutePath)).digest("hex"));
  }
});

test("PDF extraction rejects invalid and textless input safely", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lifelink-rag-"));
  try {
    const invalid = path.join(directory, "invalid.pdf");
    await writeFile(invalid, "not a pdf");
    await assert.rejects(extractPdfPages(invalid), /valid PDF header/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Markdown chunking remains backward compatible", () => {
  const chunks = chunkDocument("# Existing heading\n\n" + "A documented workflow paragraph. ".repeat(8), 500, 80);
  assert.ok(chunks.length);
  assert.equal(chunks[0].heading, "Existing heading");
  assert.ok(chunks[0].content.includes("documented workflow"));
});

test("indexing preserves page/source metadata and skips an unchanged indexed checksum", async () => {
  assert.equal(isKnowledgeSourceUnchanged({ content_sha256: "abc", status: "INDEXED" }, "abc"), true);
  assert.equal(isKnowledgeSourceUnchanged({ content_sha256: "abc", status: "FAILED" }, "abc"), false);
  assert.equal(isKnowledgeSourceUnchanged({ content_sha256: "abc", status: "INDEXED" }, "new"), false);

  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  const storedChunks: Array<Record<string, unknown>> = [];
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(0.01) } });
    if (url.includes("lifelink_rag_sources")) {
      const row = JSON.parse(String(init?.body));
      return Response.json([{ id: "test-source-id", source_key: "fixture", status: row.status, chunk_count: row.chunk_count, content_sha256: row.content_sha256, indexed_at: row.indexed_at }]);
    }
    if (url.includes("lifelink_rag_chunks") && init?.method === "POST") {
      storedChunks.push(...JSON.parse(String(init.body)) as Array<Record<string, unknown>>);
      return new Response(null, { status: 201 });
    }
    if (url.includes("lifelink_rag_chunks") && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected mocked request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    const outcome = await indexKnowledgeSource({
      definition: {
        sourceKey: "fixture", relativePath: "docs/pdf-knowledge/fixture.pdf", title: "Fixture",
        sourceType: "MEDICAL_REFERENCE", visibilityRoles: ["USER"], description: "test source",
      },
      absolutePath: "fixture.pdf", checksum: "fixture-checksum", pages: [{ pageNumber: 7, content: "A useful reference passage. ".repeat(8) }],
    });
    assert.equal(outcome.status, "INDEXED");
    assert.equal(storedChunks.length, 1);
    const metadata = storedChunks[0].metadata as Record<string, unknown>;
    assert.deepEqual(metadata.pageNumbers, [7]);
    assert.equal(metadata.sourceKey, "fixture");
    assert.equal(metadata.relativePath, "docs/pdf-knowledge/fixture.pdf");
    assert.equal(metadata.version, "fixture-checksum");
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("retrieval-backed medical and synthetic answers are attributed and unsupported evidence is declined", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "GEMINI_API_KEY"];
  const oldValues = new Map(names.map((name) => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  let fixture: "medical" | "synthetic" | "empty" = "medical";
  for (const name of names) process.env[name] = name === "SUPABASE_URL" ? "https://unit-test.supabase.co" : "unit-test";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(":embedContent")) return Response.json({ embedding: { values: Array(768).fill(0.01) } });
    if (url.includes("/rpc/")) {
      if (fixture === "empty") return Response.json([]);
      const medical = fixture === "medical";
      return Response.json([{
        id: "fixture-chunk", source_key: medical ? "medical-encyclopedia" : "lifelink-sample-data",
        title: medical ? "Medical Encyclopedia (General Education)" : "LifeLink Sample Data and Test Fixtures (Fictional)",
        source_type: medical ? "MEDICAL_REFERENCE" : "SYNTHETIC_DATASET",
        content: medical ? "Asthma is a chronic inflammatory disease of the airways." : "The dataset includes 30 fictional donor profiles.",
        similarity: 0.91, metadata: { pageNumbers: [medical ? 24 : 8] },
      }]);
    }
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> }; contents?: Array<{ parts?: Array<{ text?: string }> }> };
      if (body.systemInstruction?.parts?.[0]?.text?.startsWith("Classify the current user's message")) {
        const message = body.contents?.[0]?.parts?.[0]?.text ?? "";
        const intent = message.includes("asthma") ? "MEDICAL_OR_CLINICAL" : "KNOWLEDGE";
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intent }) }] } }] });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: "The retrieved passage states this information." }] } }] });
    }
    throw new Error("Unexpected mocked request");
  };
  try {
    const actor = { role: "USER", principalType: "USER" } as const;
    const medical = await generateAssistantResponse({ message: "What is asthma?", actor, history: [] });
    assert.equal(medical.knowledgeUsed, true);
    assert.match(medical.answer, /General medical education/);
    assert.equal(medical.sources[0]?.pageNumbers?.[0], 24);

    fixture = "synthetic";
    const synthetic = await generateAssistantResponse({ message: "How many donor profiles are included in the sample dataset?", actor, history: [] });
    assert.match(synthetic.answer, /Synthetic test data.*fictional records/i);
    assert.equal(synthetic.sources[0]?.pageNumbers?.[0], 8);

    fixture = "empty";
    const missing = await generateAssistantResponse({ message: "What is asthma?", actor, history: [] });
    assert.equal(missing.knowledgeUsed, false);
    assert.match(missing.answer, /couldn't find a relevant passage/i);
    assert.match(missing.answer, /external web search (?:is not|isn't) configured/i);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("document chunking preserves text and bounds chunk size with overlap", () => {
  const content = [
    "# Blood Workflow",
    "A blood request is validated and saved before matching starts.",
    "Institutions can respond to offers. Accepted offers follow the reservation workflow.",
    "The status shown by the operational application is authoritative.",
  ].join("\n\n");
  const chunks = chunkDocument(content, 500, 80);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 500));
  assert.ok(chunks.some((chunk) => chunk.heading === "Blood Workflow"));
  assert.ok(chunks.map((chunk) => chunk.content).join("\n").includes("reservation workflow"));
});

test("long paragraphs are chunked without exceeding limits or looping on the final overlap", () => {
  const longParagraph = Array.from({ length: 1200 }, (_, index) => `token${index}`).join(" ");
  const chunks = chunkDocument(longParagraph, 500, 80);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 500));
  assert.ok(chunks[0].content.startsWith("token0"));
  assert.ok(chunks[chunks.length - 1].content.includes("token1199"));
});

test("location extraction builds a geocoding query from an explicitly supplied area", () => {
  assert.equal(
    extractLocationQuery("I live in Indore, near Vijay Nagar. Can you find nearby blood donation centres?"),
    "Vijay Nagar, Indore, India",
  );
  assert.equal(extractLocationQuery("Find a nearby blood bank"), null);
  assert.equal(extractLocationQuery("Find a blood bank near Vijay Nagar, Indore."), "Vijay Nagar, Indore, India");
});

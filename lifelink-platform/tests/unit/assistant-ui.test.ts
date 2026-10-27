import assert from "node:assert/strict";
import test from "node:test";
import { classifyQueryIntent, isRephraseRequest } from "../../packages/rag/src/intent";
import { planAssistantRoute, type OperationalContext } from "../../apps/api/src/modules/rag/routing";
import { chooseDisplay, generateAssistantResponse } from "../../apps/api/src/modules/rag/orchestrator";
import { commonsPhotoFromTags, mapExternalPlace } from "../../apps/api/src/modules/maps/facility-discovery.service";
import { directionsLinks, markerKind, safePhoneHref } from "../../apps/web/components/map/map-presentation";
import { NO_FILTERS, applyFacilityView, availableFilters, facilityResultsHeading, formatDistance, safeFacilityPhoto, uniqueFacilities } from "../../apps/web/components/assistant/facility-presentation";
import { parseInline, parseRichText } from "../../apps/web/components/assistant/rich-text";
import { resolveDisplay, locationPromptTitle } from "../../apps/web/components/assistant/response-display";
import type { DiscoveredFacility } from "../../apps/web/components/assistant/conversation-types";
import type { AuthContext } from "../../apps/api/src/middleware/auth";

// UI-facing behaviour of the redesigned assistant: response contract (UT-UI-1x), follow-ups (UT-CTX-1x),
// facility cards and map helpers (UT-FAC), rich text (UT-TXT). All providers are mocked or unused;
// map rendering itself (markers, popups, fit/recenter) is verified in the browser, not here.

const user: AuthContext = { userId: "user-1", role: "USER", principalType: "USER" };

function facility(overrides: Partial<DiscoveredFacility>): DiscoveredFacility {
  return {
    id: "osm:node:1", name: "City Hospital", type: "HOSPITAL", address: "MG Road", latitude: 22.72, longitude: 75.86,
    phone: null, website: null, openingHours: null, photoUrl: null, sourceUrl: null, distanceKm: 1.2,
    emergencyServiceStatus: "UNKNOWN", retrievedAt: "2026-10-27T08:00:00.000Z", source: "OPENSTREETMAP", verification: "EXTERNAL_LISTING",
    inventory: { status: "NOT_FOUND" }, directionsUrl: null, ...overrides,
  };
}

const hospitals: OperationalContext = {
  facilities: [
    { index: 0, name: "Far General", type: "HOSPITAL", address: "Ring Road", phone: null, distanceKm: 5.5, latitude: 22.7, longitude: 75.9, directionsUrl: null, source: "OPENSTREETMAP", hadInventory: false, raw: { id: "osm:node:5", source: "OPENSTREETMAP" } },
    { index: 1, name: "Near Care Hospital", type: "HOSPITAL", address: "Palasia", phone: "+91 731 222 1111", distanceKm: 0.8, latitude: 22.72, longitude: 75.88, directionsUrl: null, source: "LIFELINK", hadInventory: false, raw: { id: "lifelink:3f6c2b1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c", source: "LIFELINK" } },
  ],
  category: "hospital", center: { latitude: 22.719, longitude: 75.857 }, selectedIndex: null, renderable: true, provider: "OPENSTREETMAP",
};

test("UT-CTX-10 'which one is closest' answers from the earlier results without a new search", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("no network expected"); };
  try {
    assert.deepEqual(planAssistantRoute("Which one is closest?", [], hospitals).followUp, { kind: "CLOSEST" });
    const result = await generateAssistantResponse({ message: "Which one is closest?", actor: user, history: [], operational: hospitals });
    assert.match(result.answer, /closest one is \*\*Near Care Hospital\*\*/);
    assert.equal(result.data?.selectedFacilityIndex, 1);
    assert.equal(result.display, "facilities");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("UT-CTX-11 switching facility type mid-conversation starts a new search in the same area", () => {
  for (const message of ["What about pharmacies instead?", "Actually, I need a pharmacy", "Can you find a medical store near me?"]) {
    const plan = planAssistantRoute(message, [], hospitals);
    assert.equal(plan.followUp, null, message);
    assert.equal(plan.intent, "FACILITY_DISCOVERY", message);
    assert.equal(plan.facilityCategory, "pharmacy", message);
  }
  assert.equal(classifyQueryIntent("What does a pharmacist do?"), "KNOWLEDGE");
});

test("UT-CTX-12 call, directions, more, and availability follow-ups point back at listed places", () => {
  assert.deepEqual(planAssistantRoute("Can I call this hospital?", [], { ...hospitals, selectedIndex: 1 }).followUp, { kind: "CONTACT", index: null });
  assert.deepEqual(planAssistantRoute("Open directions", [], hospitals).followUp, { kind: "DIRECTIONS", index: null });
  assert.deepEqual(planAssistantRoute("Show me more options", [], hospitals).followUp, { kind: "MORE" });
  assert.deepEqual(planAssistantRoute("Is blood available at that hospital?", [], { ...hospitals, selectedIndex: 1 }).followUp, { kind: "AVAILABILITY", index: null });
  assert.equal(planAssistantRoute("Is O-positive blood available?", [], hospitals).followUp, null, "no reference back means a normal live inventory question");
  assert.equal(isRephraseRequest("Explain the procedure in simpler terms"), true);
  assert.equal(classifyQueryIntent("Explain the procedure in simpler terms"), "GENERAL_CONVERSATION");
});

test("UT-CTX-13 availability at a public listing is answered honestly, without a database lookup", async () => {
  const result = await generateAssistantResponse({ message: "Is blood available at that hospital?", actor: user, history: [], operational: { ...hospitals, selectedIndex: 0 } });
  assert.equal(result.status, "NO_RESULTS");
  assert.match(result.answer, /public map listing, not a LifeLink-registered facility/);
});

test("UT-UI-10 the server tells the client how to present each kind of answer", () => {
  const base = { answer: "x", intent: "KNOWLEDGE" as const, knowledgeUsed: false, liveDataUsed: false, sources: [], limitations: [] };
  assert.equal(chooseDisplay({ ...base, intent: "EMERGENCY" }), "emergency");
  assert.equal(chooseDisplay({ ...base, status: "UNAVAILABLE" }), "unavailable");
  assert.equal(chooseDisplay({ ...base, data: { facilities: [] } }), "facilities");
  assert.equal(chooseDisplay({ ...base, data: { candidates: [] } }), "inventory");
  assert.equal(chooseDisplay({ ...base, status: "NEEDS_INPUT" }), "clarification");
  assert.equal(chooseDisplay({ ...base, sources: [{ sourceKey: "faq", title: "FAQ", similarity: 0.8 }] }), "knowledge");
  assert.equal(chooseDisplay({ ...base, intent: "GREETING" }), "conversation");
  // Answers saved before `display` existed are classified the same way on the client.
  assert.equal(resolveDisplay({ ...base, data: { summary: [] } }), "inventory");
  assert.equal(resolveDisplay({ ...base, display: "record" }), "record");
  assert.equal(locationPromptTitle("pharmacy"), "Find pharmacies near you");
});

test("UT-FAC-01 call actions only for valid numbers; directions only for valid coordinates", () => {
  assert.equal(safePhoneHref("+91 731 222-1111"), "tel:+917312221111");
  assert.equal(safePhoneHref("0731 2221111"), "tel:07312221111");
  for (const bad of [null, "", "javascript:alert(1)", "123", "call reception"]) assert.equal(safePhoneHref(bad), null, String(bad));
  const links = directionsLinks(22.72, 75.86);
  assert.equal(links.google, "https://www.google.com/maps/dir/?api=1&destination=22.720000%2C75.860000");
  assert.match(links.openStreetMap ?? "", /^https:\/\/www\.openstreetmap\.org\/directions\?to=22\.720000%2C75\.860000$/);
  assert.deepEqual(directionsLinks(null, 75.86), { google: null, openStreetMap: null });
  assert.deepEqual(directionsLinks(95, 75.86), { google: null, openStreetMap: null });
});

test("UT-FAC-02 photos come only from Wikimedia Commons; everything else uses the placeholder", () => {
  const commons = commonsPhotoFromTags({ wikimedia_commons: "File:City Hospital Indore.jpg" });
  assert.equal(commons?.photoUrl, "https://commons.wikimedia.org/wiki/Special:FilePath/City_Hospital_Indore.jpg?width=480");
  assert.match(commons?.photoCredit ?? "", /Wikimedia Commons/);
  assert.equal(commonsPhotoFromTags({ image: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Hospital.jpg" })?.photoUrl, "https://upload.wikimedia.org/wikipedia/commons/a/ab/Hospital.jpg");
  assert.equal(commonsPhotoFromTags({ image: "https://example.com/hospital.jpg" }), null, "arbitrary hosts are never hotlinked");
  assert.equal(commonsPhotoFromTags({ wikimedia_commons: "Category:Hospitals" }), null);
  assert.equal(mapExternalPlace({ type: "node", id: 9, lat: 22.7, lon: 75.9, tags: { name: "No Photo Clinic", amenity: "clinic" } }, "clinic", { latitude: 22.7, longitude: 75.9 })?.photoUrl, null);
  assert.equal(safeFacilityPhoto("https://upload.wikimedia.org/x.jpg"), "https://upload.wikimedia.org/x.jpg");
  assert.equal(safeFacilityPhoto("http://upload.wikimedia.org/x.jpg"), null);
  assert.equal(safeFacilityPhoto("https://evil.example/x.jpg"), null);
});

test("UT-FAC-03 duplicates, missing fields, filters and sorting never invent data", () => {
  const list = [
    facility({ id: "a", name: "A Hospital", distanceKm: 4, phone: "+91 731 111 1111" }),
    facility({ id: "a", name: "A Hospital (duplicate)" }),
    facility({ id: "b", name: "B Pharmacy", type: "PHARMACY", distanceKm: 0.6 }),
    facility({ id: "c", name: "C Registered", source: "LIFELINK", verification: "REGISTERED_ACTIVE", distanceKm: null, latitude: null, longitude: null }),
  ];
  const unique = uniqueFacilities(list);
  assert.deepEqual(unique.map((item) => item.id), ["a", "b", "c"]);
  const options = availableFilters(unique);
  assert.deepEqual(options.types.sort(), ["HOSPITAL", "PHARMACY"]);
  assert.equal(options.withPhone, true);
  assert.equal(options.emergencyListed, false, "no emergency filter without emergency data");
  assert.deepEqual(applyFacilityView(unique, "distance", NO_FILTERS).map((item) => item.id), ["b", "a", "c"], "unknown distances sort last");
  assert.deepEqual(applyFacilityView(unique, "recommended", { ...NO_FILTERS, type: "PHARMACY" }).map((item) => item.id), ["b"]);
  assert.deepEqual(applyFacilityView(unique, "recommended", { ...NO_FILTERS, withPhone: true }).map((item) => item.id), ["a"]);
  assert.equal(formatDistance(0.45), "450 m");
  assert.equal(formatDistance(null), null);
  assert.equal(unique[1].openingHours, null, "missing hours stay missing");
  assert.equal(facilityResultsHeading({ category: "pharmacy", searchLocationType: "DEVICE" }), "Pharmacies near you");
  assert.equal(facilityResultsHeading({ category: "hospital", searchLocationType: "MANUAL", area: "Palasia, Indore, Madhya Pradesh, India" }), "Hospitals near Palasia, Indore");
  assert.equal(facilityResultsHeading({ title: "Registered LifeLink institutions" }), "Registered LifeLink institutions");
  assert.equal(markerKind("PHARMACY"), "pharmacy");
  assert.equal(markerKind("SOMETHING_NEW"), "other");
});

test("UT-TXT-01 answers render headings, steps, lists and bold text safely", () => {
  const blocks = parseRichText("## How it works\nDonation has a few steps:\n1. Register\n2. Get screened\n\n- Bring ID\n- Eat first\n\n```\ncode <b>\n```\nDone **now**.");
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "steps", "bullets", "code", "paragraph"]);
  assert.deepEqual((blocks[2] as { items: string[] }).items, ["Register", "Get screened"]);
  assert.equal((blocks[4] as { code: string }).code, "code <b>");
  assert.deepEqual(parseInline("Call **City Hospital** or `112`"), [
    { kind: "text", text: "Call " }, { kind: "bold", text: "City Hospital" }, { kind: "text", text: " or " }, { kind: "code", text: "112" },
  ]);
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ kind: "text", text: "<img src=x onerror=alert(1)>" }], "markup stays text");
});

test("UT-LOC-01 'near me' means the device location and is never geocoded as a place (found in the browser check)", async () => {
  const { extractLocationQuery } = await import("../../apps/api/src/modules/rag/live-context");
  for (const message of ["Find hospitals near me", "Find a pharmacy near me.", "Show clinics around here", "blood banks near my location"]) {
    assert.equal(extractLocationQuery(message), null, message);
  }
  assert.equal(extractLocationQuery("Find hospitals near Palasia, Indore"), "Palasia, Indore, India");
});

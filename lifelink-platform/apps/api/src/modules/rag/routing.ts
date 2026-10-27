import {
  classifyQueryIntent,
  isCareSeekingRequest,
  isInstitutionDirectoryRequest,
  isUrgentBloodRequest,
  type AssistantRouteSummary,
  type ConversationTurn,
  type QueryIntent,
} from "@lifelink/rag";
import type { FacilityCategory } from "../maps/facility-discovery.service";
import { assessEmergency, type EmergencyAssessment } from "./emergency";
import { extractLocationQuery } from "./live-context";

/** A facility the assistant already showed in this conversation, as stored with that answer. */
export interface FacilityRef {
  index: number;
  name: string;
  type: string | null;
  address: string | null;
  phone: string | null;
  distanceKm: number | null;
  latitude: number | null;
  longitude: number | null;
  directionsUrl: string | null;
  source: string | null;
  hadInventory: boolean;
  raw: Record<string, unknown> | null;
}

/** Operational state from earlier answers, kept apart from the conversational text history. */
export interface OperationalContext {
  facilities: FacilityRef[];
  category: FacilityCategory | null;
  center: { latitude: number; longitude: number; displayName?: string } | null;
  selectedIndex: number | null;
  /** True when the stored list is the structured shape the facility card and map can render again. */
  renderable: boolean;
  provider: string | null;
}

export type FollowUp =
  | { kind: "SELECT"; index: number }
  | { kind: "CONTACT"; index: number | null }
  | { kind: "DIRECTIONS"; index: number | null }
  | { kind: "CLOSER" }
  | { kind: "CLOSEST" }
  | { kind: "MORE" }
  | { kind: "AVAILABILITY"; index: number | null }
  | { kind: "NO_CONTEXT" };

export interface RoutePlan {
  intent: QueryIntent;
  urgency: "CRITICAL" | "URGENT" | "ROUTINE";
  needsRag: boolean;
  needsLiveData: boolean;
  needsFacility: boolean;
  needsClarification: boolean;
  hybrid: boolean;
  facilityCategory: FacilityCategory | null;
  followUp: FollowUp | null;
  emergency: EmergencyAssessment | null;
  /** For hybrid requests: the explanatory part and the facility-search part of the message. */
  knowledgeQuery: string | null;
  facilityQuery: string | null;
}

const FACILITY_CATEGORIES: FacilityCategory[] = ["blood", "hospital", "clinic", "care", "pharmacy", "other", "emergency", "organ", "all"];
const LIVE_INTENTS: QueryIntent[] = ["REQUEST_STATUS", "LIVE_INVENTORY", "FACILITY_DISCOVERY"];

export function inferFacilityCategory(message: string): FacilityCategory | null {
  if (/\b(?:blood banks?|blood cent(?:re|er)s?|blood donation|blood|transfusion)\b/i.test(message)) return "blood";
  if (/\b(?:organ|transplant)\b/i.test(message)) return "organ";
  if (/\b(?:emergency (?:department|room|services?|ward)|trauma cent(?:re|er)|casualty)\b/i.test(message)) return "emergency";
  if (/\b(?:pharmac(?:y|ies)|chemists?|medical stores?|drug ?stores?)\b/i.test(message)) return "pharmacy";
  if (/\bclinics?\b/i.test(message)) return "clinic";
  if (/\b(?:doctors?|physicians?|gp|medical (?:care|help|attention)|checked|check-?up|examined)\b/i.test(message)) return "care";
  if (/\bhospitals?\b/i.test(message)) return "hospital";
  if (isCareSeekingRequest(message)) return "care";
  return null;
}

const KNOWLEDGE_CLAUSE = /\b(?:explain|tell me (?:how|about|what|why)|how (?:does|do|is|are)\b[\s\S]{0,60}\b(?:work|works|done|happen|happens)|what (?:is|are) (?:the )?(?:process|procedure|steps|requirements?|eligibility)|what (?:information|documents?|details|things) (?:should|do|must|would) i|what should i (?:bring|carry|know|expect)|walk me through)\b/i;
const FACILITY_CLAUSE = /\b(?:find|locate|show|list|suggest|recommend|search for)\b[\s\S]{0,40}\b(?:hospitals?|clinics?|doctors?|pharmac(?:y|ies)|blood banks?|blood cent(?:re|er)s?|organ cent(?:re|er)s?|cent(?:re|er)s|institutions?|facilities)\b|\b(?:nearby|nearest|near me|closest)\b/i;

function isFacilityClause(text: string) {
  return FACILITY_CLAUSE.test(text) || isInstitutionDirectoryRequest(text);
}

/** "Explain blood donation and find a nearby blood bank" needs both retrieval and facility search. */
export function splitHybridRequest(message: string): { knowledgeQuery: string; facilityQuery: string } | null {
  if (!KNOWLEDGE_CLAUSE.test(message) || !isFacilityClause(message)) return null;
  const clauses = message.split(/\s*(?:[,;]|\band then\b|\band also\b|\balso\b|\band\b|\bthen\b)\s*/i).map((part) => part.trim()).filter(Boolean);
  const facilityParts = clauses.filter((clause) => isFacilityClause(clause) && !KNOWLEDGE_CLAUSE.test(clause));
  const knowledgeParts = clauses.filter((clause) => !facilityParts.includes(clause));
  if (!facilityParts.length || !knowledgeParts.length) return null;
  return { knowledgeQuery: knowledgeParts.join(" and "), facilityQuery: facilityParts.join(" and ") };
}

const ORDINAL_INDEX: Record<string, number> = {
  first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3,
  fifth: 4, "5th": 4, sixth: 5, "6th": 5, seventh: 6, "7th": 6, eighth: 7, "8th": 7,
};
const LIST_NOUN = "(?:one|option|result|place|facility|listing|entry|hospital|clinic|pharmacy|blood bank|centre|center|institution)";

/** Returns a zero-based list position for "the second one", "option 3", or "the last one". */
export function referencedListIndex(message: string, count: number): number | null {
  const ordinal = message.match(new RegExp(`\\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last)\\b(?=\\s+${LIST_NOUN}\\b|[\\s?.!,]*$|\\s+(?:again|on (?:the|that) list|in (?:the|that) list|from (?:the|that) list)\\b)`, "i"));
  if (ordinal) {
    const word = ordinal[1].toLowerCase();
    return word === "last" ? (count > 0 ? count - 1 : null) : ORDINAL_INDEX[word];
  }
  const numbered = message.match(/(?:\b(?:number|no\.?|option|result)\s*|#)(\d{1,2})\b/i);
  return numbered ? Number(numbered[1]) - 1 : null;
}

const REFERENTIAL = /\b(?:its|their|it|them|that one|this one|that place|there|the same one|(?:this|that|the same) (?:hospital|clinic|pharmacy|medical store|blood bank|place|facility|centre|center|one))\b/i;
const CONTACT = /\b(?:contact|phone|number|call|reach|telephone|mobile)\b/i;
const DIRECTIONS = /\b(?:directions?|how (?:do|can) i get there|route to|way (?:to it|there)|navigate)\b/i;
const CLOSER = /\b(?:closer|nearer|something (?:closer|nearer)|anything (?:closer|nearer)|too far|less far)\b/i;
const CLOSEST = /\b(?:which (?:one |of (?:them|these|those) )?is (?:the )?(?:closest|nearest)|the (?:closest|nearest) one|(?:closest|nearest) (?:of|among) (?:them|these|those))\b/i;
const MORE = /\b(?:more (?:options|results|places|facilities)|show (?:me )?more|other options|any(?:thing| others?) else(?: nearby)?|search wider|wider (?:area|search))\b/i;
const AVAILABILITY = /\b(?:blood|stock|units?|inventory)\b[\s\S]{0,40}\b(?:available|availability|there|in stock|have)\b|\b(?:is|are|does|do|any)\b[\s\S]{0,30}\b(?:blood|stock|units?)\b/i;

function detectFollowUp(message: string, operational: OperationalContext | null, category: FacilityCategory | null): FollowUp | null {
  const text = message.trim();
  if (text.length > 140) return null;
  const count = operational?.facilities.length ?? 0;
  const index = referencedListIndex(text, count);
  const referential = REFERENTIAL.test(text) || index !== null;
  // "Show me number 2" selects a result; it is not asking for a phone number.
  const contact = CONTACT.test(text.replace(/\b(?:number|no\.?|option|result)\s*\d{1,2}\b/gi, "")) && !/\b(?:emergency|request|donation|reference|my number)\b/i.test(text) &&
    (referential || text.length <= 50);
  const directions = DIRECTIONS.test(text) && (referential || text.length <= 50);
  const availability = AVAILABILITY.test(text) && referential;
  const closest = CLOSEST.test(text);
  const closer = !closest && CLOSER.test(text);
  const more = MORE.test(text);
  const selectWords = index !== null && (new RegExp(`\b${LIST_NOUN}\b`, "i").test(text) || /\b(?:show|again|tell me|what about|details|more about|open|select)\b/i.test(text));
  if (!contact && !directions && !availability && !closest && !closer && !more && !selectWords) return null;
  if (!count) return { kind: "NO_CONTEXT" };
  // A different facility type is a new search ("Actually, I need a pharmacy"), never a follow-up,
  // unless the message points back at a listed place ("Can I call this hospital?").
  const compatible = !category || !operational?.category || category === operational.category ||
    (["care", "clinic", "hospital"].includes(category) && ["care", "clinic", "hospital"].includes(operational.category));
  if (!referential && !compatible) return null;
  if (!referential && extractLocationQuery(text)) return null;
  if (availability) return { kind: "AVAILABILITY", index };
  if (contact) return { kind: "CONTACT", index };
  if (directions) return { kind: "DIRECTIONS", index };
  if (closest) return { kind: "CLOSEST" };
  if (closer) return { kind: "CLOSER" };
  if (more) return { kind: "MORE" };
  return { kind: "SELECT", index: index! };
}

/** Deterministic route decision. Emergencies are decided first and never depend on history alone. */
export function planAssistantRoute(message: string, history: ConversationTurn[] = [], operational: OperationalContext | null = null): RoutePlan {
  const emergency = assessEmergency(message, history);
  const facilityCategory = inferFacilityCategory(message);
  const base = {
    emergency, facilityCategory, hybrid: false, followUp: null, knowledgeQuery: null, facilityQuery: null,
    needsClarification: false,
  };
  if (emergency) {
    return { ...base, intent: "EMERGENCY", urgency: "CRITICAL", needsRag: false, needsLiveData: false, needsFacility: true, facilityCategory: "emergency" };
  }
  const urgency = isUrgentBloodRequest(message, history) || /\b(?:urgent(?:ly)?|immediately|right now|asap)\b/i.test(message) ? "URGENT" : "ROUTINE";
  const followUp = detectFollowUp(message, operational, facilityCategory);
  if (followUp?.kind === "NO_CONTEXT") {
    return { ...base, followUp, intent: "AMBIGUOUS", urgency, needsRag: false, needsLiveData: false, needsFacility: false, needsClarification: true };
  }
  if (followUp) {
    return { ...base, followUp, intent: "FACILITY_DISCOVERY", urgency, needsRag: false, needsLiveData: ["CLOSER", "MORE", "AVAILABILITY"].includes(followUp.kind), needsFacility: true, facilityCategory: operational?.category ?? facilityCategory };
  }
  const hybrid = splitHybridRequest(message);
  if (hybrid) {
    return { ...base, ...hybrid, hybrid: true, intent: "FACILITY_DISCOVERY", urgency, needsRag: true, needsLiveData: true, needsFacility: true, facilityCategory: inferFacilityCategory(hybrid.facilityQuery) ?? facilityCategory };
  }
  const intent = classifyQueryIntent(message);
  return {
    ...base, intent, urgency,
    needsRag: intent === "KNOWLEDGE" || intent === "MEDICAL_OR_CLINICAL" || intent === "FIRST_AID",
    needsLiveData: LIVE_INTENTS.includes(intent),
    needsFacility: intent === "FACILITY_DISCOVERY",
    needsClarification: intent === "AMBIGUOUS",
    facilityCategory: intent === "FACILITY_DISCOVERY" ? facilityCategory ?? "all" : facilityCategory,
  };
}

export function toRouteSummary(plan: RoutePlan, overrides: Partial<AssistantRouteSummary> = {}): AssistantRouteSummary {
  return {
    intent: plan.intent, urgency: plan.urgency, needsRag: plan.needsRag, needsLiveData: plan.needsLiveData,
    needsFacility: plan.needsFacility, needsClarification: plan.needsClarification, hybrid: plan.hybrid,
    facilityCategory: plan.facilityCategory, followUp: plan.followUp?.kind ?? null, ...overrides,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function toFacilityRef(item: Record<string, unknown>, index: number): FacilityRef | null {
  const name = text(item.name) ?? text(item.institution);
  if (!name) return null;
  const inventory = asRecord(item.inventory);
  return {
    index, name,
    type: text(item.type),
    address: text(item.address),
    phone: text(item.phone) ?? text(item.contactNumber),
    distanceKm: finite(item.distanceKm),
    latitude: finite(item.latitude),
    longitude: finite(item.longitude),
    directionsUrl: text(item.directionsUrl),
    source: text(item.source),
    hadInventory: Boolean(inventory && inventory.status === "CONFIRMED") || finite(item.unitsAvailable) !== null,
    raw: item,
  };
}

/**
 * Finds the latest facility list shown in this conversation. Only structured results the
 * server or the facility search stored are used; assistant prose is never parsed for facts.
 */
export function extractOperationalContext(messages: Array<{ role: "user" | "assistant"; result?: unknown }>): OperationalContext | null {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const data = asRecord(asRecord(message.result)?.data);
    if (!data) continue;
    const list = Array.isArray(data.facilities) ? data.facilities : Array.isArray(data.candidates) ? data.candidates : null;
    if (!list?.length) continue;
    const facilities = list.map((item, index) => { const record = asRecord(item); return record ? toFacilityRef(record, index) : null; })
      .filter((item): item is FacilityRef => item !== null);
    if (!facilities.length) continue;
    const center = asRecord(data.center);
    const latitude = finite(center?.latitude), longitude = finite(center?.longitude);
    const category = text(data.facilityCategory);
    const selected = finite(data.selectedFacilityIndex);
    return {
      facilities,
      category: category && FACILITY_CATEGORIES.includes(category as FacilityCategory) ? category as FacilityCategory : null,
      center: latitude !== null && longitude !== null ? { latitude, longitude, ...(text(center?.displayName) ? { displayName: text(center?.displayName)! } : {}) } : null,
      selectedIndex: selected !== null && selected >= 0 && selected < facilities.length ? selected : null,
      renderable: Array.isArray(data.facilities) && facilities.every((facility) => facility.raw?.id !== undefined && facility.raw?.source !== undefined),
      provider: text(data.facilityProvider),
    };
  }
  return null;
}

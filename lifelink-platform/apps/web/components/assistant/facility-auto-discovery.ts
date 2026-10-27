import type { AssistantResult } from "./conversation-types";

export type AutoFacilityCategory = "emergency" | "hospital" | "clinic" | "care" | "pharmacy" | "blood";
const AUTO_CATEGORIES: AutoFacilityCategory[] = ["emergency", "hospital", "clinic", "care", "pharmacy", "blood"];

export function inferAutoFacilityCategory(message: string, result: AssistantResult): AutoFacilityCategory | null {
  if (Array.isArray(result.data?.facilities)) return null;
  if (result.intent === "EMERGENCY") return "emergency";
  if (result.data?.careRecommendation === "PROMPT_ASSESSMENT") return "hospital";
  const normalized = message.toLocaleLowerCase();
  if (result.intent === "FIRST_AID" && /\b(?:pharmacy|bandage|dressing|gauze|wound supplies)\b/i.test(result.answer) && /\b(?:cut|cuts|scrape|graze|wound|burn)\b/i.test(normalized)) return "pharmacy";
  if (result.intent === "LIVE_INVENTORY" && /\b(?:blood|transfusion|blood bank|donat(?:e|ion))\b/.test(normalized) && /\b(?:need|needs|urgent|urgently|find|locate|transfusion|donat(?:e|ion))\b/.test(normalized)) return "blood";
  if (result.intent === "FACILITY_DISCOVERY") {
    // The server's deterministic route already chose the facility type for this turn.
    const routed = result.data?.facilityCategory;
    if (typeof routed === "string" && AUTO_CATEGORIES.includes(routed as AutoFacilityCategory)) return routed as AutoFacilityCategory;
    if (/\b(?:pharmacy|pharmacies|chemist|medical store)\b/.test(normalized)) return "pharmacy";
    if (/\b(?:i (?:think|feel|might|may|probably) need to (?:see|visit|talk to|consult) (?:a|the) (?:doctor|physician)|i need (?:to see )?(?:a|the) doctor|i should (?:see|visit) (?:a|the) doctor|should i (?:see|visit) (?:a|the) doctor|i need (?:medical )?(?:care|assessment)|i want to (?:see|visit) (?:a|the) doctor)\b/.test(normalized)) return "care";
    if (/\b(?:clinic|clinics|doctor|doctors|urgent care)\b/.test(normalized)) return "clinic";
    if (/\b(?:blood|blood bank|transfusion|donat(?:e|ion))\b/.test(normalized)) return "blood";
    if (/\b(?:hospital|emergency|injury|accident|bleeding|care)\b/.test(normalized)) return "hospital";
  }
  if (result.intent === "MEDICAL_OR_CLINICAL" && /\b(?:where can i (?:get|buy|fill)|find (?:a )?nearby|nearest|nearby|prescription|pharmacy|medicine|medication)\b/.test(normalized) && /\b(?:pharmacy|medicine|medication|prescription|chemist)\b/.test(normalized)) return "pharmacy";
  return null;
}

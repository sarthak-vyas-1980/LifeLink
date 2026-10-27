import type { AssistantDisplay, AssistantResult } from "./conversation-types";

/**
 * The presentation for an answer. New answers carry `display` from the server; answers saved
 * before that field existed are classified from the same structured fields, never from prose.
 */
export function resolveDisplay(result: AssistantResult | undefined): AssistantDisplay {
  if (!result) return "conversation";
  if (result.display) return result.display;
  if (result.intent === "EMERGENCY") return "emergency";
  if (result.status === "UNAVAILABLE") return "unavailable";
  if (Array.isArray(result.data?.facilities)) return "facilities";
  if (Array.isArray(result.data?.candidates) || Array.isArray(result.data?.summary)) return "inventory";
  if (result.status === "NEEDS_INPUT") return "clarification";
  if (result.intent === "REQUEST_STATUS") return "record";
  if (result.sources?.length || result.knowledgeUsed) return "knowledge";
  return "conversation";
}

const CATEGORY_PROMPT: Record<string, string> = {
  pharmacy: "Find pharmacies near you", hospital: "Find hospitals near you", emergency: "Find emergency-capable hospitals near you",
  clinic: "Find clinics and doctors near you", care: "Find clinics and hospitals near you", blood: "Find blood banks near you",
};

export function locationPromptTitle(category: string | null | undefined): string {
  return CATEGORY_PROMPT[category ?? ""] ?? "Find healthcare facilities near you";
}

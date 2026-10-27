export type LifeLinkRole =
  | "USER"
  | "ADMINISTRATOR"
  | "HOSPITAL_USER"
  | "BLOOD_BANK_USER"
  | "ORGAN_CENTRE_USER";

export type QueryIntent =
  | "KNOWLEDGE"
  | "REQUEST_STATUS"
  | "LIVE_INVENTORY"
  | "FACILITY_DISCOVERY"
  | "WORKFLOW_ACTION"
  | "MEDICAL_OR_CLINICAL"
  | "FIRST_AID"
  | "EMERGENCY"
  | "GENERAL_CONVERSATION"
  | "GREETING"
  | "OUT_OF_SCOPE"
  | "AMBIGUOUS"
  | "UNKNOWN";

export interface KnowledgeSourceDefinition {
  sourceKey: string;
  relativePath: string;
  title: string;
  sourceType: "FAQ" | "WORKFLOW" | "POLICY" | "SRS" | "ARCHITECTURE" | "MEDICAL_REFERENCE" | "SYNTHETIC_DATASET";
  visibilityRoles: LifeLinkRole[];
  description: string;
}

export interface KnowledgeChunkInput {
  sourceKey: string;
  title: string;
  sourceType: string;
  relativePath: string;
  chunkIndex: number;
  content: string;
  heading?: string;
  version: string;
  visibilityRoles: LifeLinkRole[];
  pageNumbers?: number[];
}

export interface KnowledgePage {
  pageNumber: number;
  content: string;
}

export interface RetrievedKnowledgeChunk {
  id: string;
  sourceKey: string;
  title: string;
  sourceType: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface KnowledgeSourceStatus {
  sourceKey: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  indexedAt?: string | null;
}

export interface AssistantSourceReference {
  sourceKey: string;
  title: string;
  similarity: number;
  pageNumbers?: number[];
}

export interface AssistantAnswer {
  answer: string;
  intent: QueryIntent;
  knowledgeUsed: boolean;
  liveDataUsed: boolean;
  sources: AssistantSourceReference[];
  limitations: string[];
  data?: Record<string, unknown>;
  handoff?: {
    label: string;
    href: string;
    reason: string;
  };
  /** Outcome of the capability that answered, so clients can tell "no results" from "service unavailable". */
  status?: AssistantResultStatus;
  /** Short follow-up prompts the user can send next; never claims of completed actions. */
  suggestions?: string[];
  /** The validated deterministic route decision, for transparency and auditing. */
  route?: AssistantRouteSummary;
  /** How the client should present this answer; the structured content itself is in `data` and `sources`. */
  display?: AssistantDisplay;
}

export type AssistantDisplay = "conversation" | "knowledge" | "facilities" | "inventory" | "record" | "emergency" | "clarification" | "unavailable";

export type AssistantResultStatus = "ANSWERED" | "NO_RESULTS" | "NEEDS_INPUT" | "UNAVAILABLE" | "NOT_PERMITTED";

export interface AssistantRouteSummary {
  intent: QueryIntent;
  urgency: "CRITICAL" | "URGENT" | "ROUTINE";
  needsRag: boolean;
  needsLiveData: boolean;
  needsFacility: boolean;
  needsClarification: boolean;
  hybrid: boolean;
  facilityCategory: string | null;
  followUp: string | null;
}

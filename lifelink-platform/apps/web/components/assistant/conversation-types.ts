export interface AssistantSource { sourceKey: string; title: string; similarity: number; pageNumbers?: number[] }
export interface Handoff { label: string; href: string; reason: string }
export interface DiscoveredFacility {
  id: string; name: string; type: "BLOOD_BANK" | "HOSPITAL" | "ORGAN_CENTRE" | "EMERGENCY_DEPARTMENT" | "CLINIC" | "PHARMACY" | "OTHER_HEALTHCARE_FACILITY"; address: string; latitude: number | null; longitude: number | null;
  phone: string | null; website: string | null; openingHours: string | null; photoUrl: string | null; photoCredit?: string | null; photoSourceUrl?: string | null; sourceUrl: string | null; distanceKm: number | null;
  emergencyServiceStatus: "REGISTERED" | "LISTED" | "UNKNOWN";
  retrievedAt: string;
  source: "LIFELINK" | "OPENSTREETMAP"; verification: "REGISTERED_ACTIVE" | "EXTERNAL_LISTING";
  inventory: { status: "CONFIRMED" | "STALE" | "NOT_FOUND" | "UNAVAILABLE"; bloodGroup?: string; component?: string; units?: number; updatedAt?: string };
  directionsUrl: string | null;
}
export interface FacilitySearchResult {
  facilities: DiscoveredFacility[]; center: { latitude: number; longitude: number; displayName?: string } | null;
  provider: string; unavailableReason?: "NOT_CONFIGURED" | "LOCATION_UNAVAILABLE" | "RATE_LIMITED" | "LOOKUP_FAILED"; attribution?: string; searchLocationType?: "DEVICE" | "MANUAL"; category?: string;
  /** Heading for lists that are not proximity searches, such as the registered-institution directory. */
  title?: string;
  /** Hide per-facility stock lines when stock was not checked for this list (directory, follow-up re-display). */
  hideInventory?: boolean;
  /** A result the user referred to ("the second one"), highlighted in the list and on the map. */
  selectedId?: string;
}
export type AssistantDisplay = "conversation" | "knowledge" | "facilities" | "inventory" | "record" | "emergency" | "clarification" | "unavailable";
export interface InventorySummaryRow { bloodGroup: string; units: number; facilityCount: number; latestUpdate: string; staleRecords: number }
export interface InventoryRecord { group: string; component: string; unitsAvailable: number; institutionId?: string; institution: string; address: string; contactNumber: string | null; distanceKm: number | null; lastUpdated: string; stale: boolean; expiryDate: string | null }
export interface AssistantResult {
  answer: string; intent: string; knowledgeUsed: boolean; liveDataUsed: boolean;
  sources: AssistantSource[]; limitations: string[]; handoff?: Handoff; answeredAt?: string; data?: Record<string, unknown>;
  status?: "ANSWERED" | "NO_RESULTS" | "NEEDS_INPUT" | "UNAVAILABLE" | "NOT_PERMITTED"; suggestions?: string[];
  display?: AssistantDisplay;
  route?: { intent: string; urgency: string; needsRag: boolean; needsLiveData: boolean; needsFacility: boolean; needsClarification: boolean; hybrid: boolean; facilityCategory: string | null; followUp: string | null };
}
export interface ChatMessage {
  id: string; role: "user" | "assistant"; content: string; result?: AssistantResult; createdAt?: string;
  failed?: boolean; errorMessage?: string; deliveryStatus?: "sending" | "failed";
}
export interface ConversationSummary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }

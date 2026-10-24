export interface AssistantSource { sourceKey: string; title: string; similarity: number; pageNumbers?: number[] }
export interface Handoff { label: string; href: string; reason: string }
export interface DiscoveredFacility {
  id: string; name: string; type: "BLOOD_BANK" | "HOSPITAL" | "ORGAN_CENTRE" | "EMERGENCY_DEPARTMENT" | "CLINIC" | "PHARMACY" | "OTHER_HEALTHCARE_FACILITY"; address: string; latitude: number | null; longitude: number | null;
  phone: string | null; website: string | null; openingHours: string | null; photoUrl: string | null; sourceUrl: string | null; distanceKm: number | null;
  emergencyServiceStatus: "REGISTERED" | "LISTED" | "UNKNOWN";
  retrievedAt: string;
  source: "LIFELINK" | "OPENSTREETMAP"; verification: "REGISTERED_ACTIVE" | "EXTERNAL_LISTING";
  inventory: { status: "CONFIRMED" | "STALE" | "NOT_FOUND" | "UNAVAILABLE"; bloodGroup?: string; component?: string; units?: number; updatedAt?: string };
  directionsUrl: string | null;
}
export interface FacilitySearchResult {
  facilities: DiscoveredFacility[]; center: { latitude: number; longitude: number; displayName?: string } | null;
  provider: string; unavailableReason?: "NOT_CONFIGURED" | "LOCATION_UNAVAILABLE" | "RATE_LIMITED" | "LOOKUP_FAILED"; attribution?: string; searchLocationType?: "DEVICE" | "MANUAL"; category?: string;
}
export interface AssistantResult {
  answer: string; intent: string; knowledgeUsed: boolean; liveDataUsed: boolean;
  sources: AssistantSource[]; limitations: string[]; handoff?: Handoff; answeredAt?: string; data?: Record<string, unknown>;
}
export interface ChatMessage {
  id: string; role: "user" | "assistant"; content: string; result?: AssistantResult; createdAt?: string;
  failed?: boolean; errorMessage?: string; deliveryStatus?: "sending" | "failed";
}
export interface ConversationSummary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }

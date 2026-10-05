// Shared domain vocabulary used by API validation, persistence, and UI selectors.
export const USER_ROLES = [
	"USER",
	"ADMIN",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

// Access scopes are derived from the selected account context, not stored as user roles.
export const ACCESS_ROLES = [
  "HOSPITAL_USER", "BLOOD_BANK_USER", "ORGAN_CENTRE_USER",
  "USER", "ADMINISTRATOR",
] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export const INSTITUTION_TYPES = [
  "HOSPITAL",
  "BLOOD_BANK",
  "ORGAN_CENTRE",
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const BLOOD_GROUPS = [
  "A_POSITIVE",
  "A_NEGATIVE",
  "B_POSITIVE",
  "B_NEGATIVE",
  "AB_POSITIVE",
  "AB_NEGATIVE",
  "O_POSITIVE",
  "O_NEGATIVE",
] as const;

export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const BLOOD_COMPONENTS = [
  "WHOLE_BLOOD",
  "RED_BLOOD_CELLS",
  "PLASMA",
  "PLATELETS",
  "CRYOPRECIPITATE",
] as const;

export type BloodComponent = (typeof BLOOD_COMPONENTS)[number];

export const REQUEST_TYPES = ["BLOOD", "ORGAN"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_PRIORITIES = ["NORMAL", "URGENT", "EMERGENCY"] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export const BLOOD_INVENTORY_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "UNAVAILABLE",
  "EXPIRED",
] as const;

export type BloodInventoryStatus = (typeof BLOOD_INVENTORY_STATUSES)[number];

export const REQUEST_STATUSES = [
  "CREATED",
  "UNDER_REVIEW",
  "SEARCHING_MATCHING",
  "INSTITUTIONS_NOTIFIED",
  "OFFERS_RECEIVED",
  "OFFER_EVALUATION",
  "OFFER_ACCEPTED",
  "RESERVED",
  "IN_TRANSIT",
  "FULFILLED",
  "REOPENED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const MATCH_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const WORKFLOW_EVENT_TYPES = [
  "REQUEST_CREATED",
  "REQUEST_STATUS_CHANGED",
  "INVENTORY_CHANGED",
  "OFFER_RECEIVED",
  "OFFER_ACCEPTED",
  "OFFER_REJECTED",
  "RESERVATION_EXPIRED",
  "REQUEST_FULFILLED",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export function getSupportedEnumValues() {
  return {
    USER_ROLES,
    INSTITUTION_TYPES,
    BLOOD_GROUPS,
    BLOOD_COMPONENTS,
    REQUEST_TYPES,
    REQUEST_PRIORITIES,
    BLOOD_INVENTORY_STATUSES,
    REQUEST_STATUSES,
    MATCH_STATUSES,
    WORKFLOW_EVENT_TYPES,
  };
}

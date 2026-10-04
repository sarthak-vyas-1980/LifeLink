import type { RequestStatus } from "./enums";

// Canonical blood-request state machine from creation through closure.
export const BLOOD_REQUEST_TRANSITIONS: Record<
  RequestStatus,
  readonly RequestStatus[]
> = {
  CREATED: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["SEARCHING_MATCHING", "CANCELLED"],
  SEARCHING_MATCHING: ["INSTITUTIONS_NOTIFIED", "REOPENED", "CANCELLED"],
  INSTITUTIONS_NOTIFIED: [
    "OFFERS_RECEIVED",
    "REOPENED",
    "EXPIRED",
    "CANCELLED",
  ],
  OFFERS_RECEIVED: ["OFFER_EVALUATION", "REOPENED", "CANCELLED"],
  OFFER_EVALUATION: ["OFFER_ACCEPTED", "REJECTED", "REOPENED", "CANCELLED"],
  OFFER_ACCEPTED: ["RESERVED", "REOPENED", "EXPIRED"],
  RESERVED: ["IN_TRANSIT", "EXPIRED", "REOPENED", "CANCELLED"],
  IN_TRANSIT: ["FULFILLED", "EXPIRED"],
  FULFILLED: [],
  REOPENED: ["SEARCHING_MATCHING", "CANCELLED"],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
};

export const FINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
  "FULFILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
];

export function isAllowedTransition(from: RequestStatus, to: RequestStatus) {
  return BLOOD_REQUEST_TRANSITIONS[from].includes(to);
}

export function isFinalState(status: RequestStatus) {
  return FINAL_REQUEST_STATUSES.includes(status);
}

export function getNextRequestStatuses(status: RequestStatus) {
  return BLOOD_REQUEST_TRANSITIONS[status];
}

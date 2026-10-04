import type {
  BloodComponent,
  BloodGroup,
  RequestPriority,
  RequestStatus,
  WorkflowEventType,
} from "./enums";

export interface ApiErrorContract {
  code: string;
  message: string;
  traceId?: string;
  fieldErrors?: Record<string, string[]>;
}

export interface CreateBloodRequestInput {
  bloodGroup: BloodGroup;
  component: BloodComponent;
  quantity: number;
  priority: Exclude<RequestPriority, "EMERGENCY">;
  location: string;
  radiusKm?: number;
  contactNumber: string;
}

export interface EmergencyBloodRequestInput
  extends Omit<CreateBloodRequestInput, "priority"> {
  priority?: never;
}

export interface BloodRequestResponse {
  id: string;
  requestType: "BLOOD" | "ORGAN";
  bloodGroup: BloodGroup | null;
  component: BloodComponent | null;
  organType: string | null;
  quantity: number;
  priority: RequestPriority;
  location: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number | null;
  status: RequestStatus;
  requestDate?: string;
  contactNumber?: string;
}

export interface BloodMatchCandidateResponse {
  matchId: string;
  inventoryId: string;
  institutionId: string;
  institutionName: string;
  unitsAvailable: number;
  expiryDate: string | null;
  lastUpdated: string;
  distanceKm?: number;
  freshnessMinutes: number;
  expiryProximityHours?: number;
  score: number;
  guaranteedFulfilment: false;
}

export interface BloodMatchingResponse {
  status: "MATCHES_FOUND" | "NO_MATCH";
  candidates: BloodMatchCandidateResponse[];
  retry: {
    canWidenRadius: boolean;
    suggestedRadiusKm?: number;
    reason?: string;
  };
}

export interface EmergencyBloodRequestResponse {
  request: BloodRequestResponse;
  matching: BloodMatchingResponse;
  coordinationOnly: true;
}

export interface BloodInventorySearchCriteria {
  bloodGroup: BloodGroup;
  component: BloodComponent;
  quantity: number;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
}

export interface WorkflowEventContract {
  eventType: WorkflowEventType;
  entityId: string;
  requestId?: string;
  status?: RequestStatus;
  occurredAt: string;
  correlationId: string;
}

export function createApiErrorContract(
  code: string,
  message: string,
  traceId?: string,
): ApiErrorContract {
  return { code, message, traceId };
}

export function createWorkflowEventContract(
  event: WorkflowEventContract,
): WorkflowEventContract {
  return event;
}

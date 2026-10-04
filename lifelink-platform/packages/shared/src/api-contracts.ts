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
  priority: RequestPriority;
  location: string;
  radiusKm?: number;
  contactNumber: string;
  recipientId?: string;
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

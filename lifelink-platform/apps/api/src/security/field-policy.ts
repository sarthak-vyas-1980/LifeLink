import type { AuthContext } from "../middleware/auth";
import type {
  BloodComponent,
  BloodGroup,
  BloodMatchingResponse,
  BloodRequestResponse,
  RequestPriority,
  RequestStatus,
  RequestType,
} from "@lifelink/shared";

interface RequestRecord {
  id: string;
  requestType: RequestType;
  bloodGroup?: BloodGroup | null;
  component?: BloodComponent | null;
  organType?: string | null;
  quantity: number;
  priority: RequestPriority;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  radiusKm?: number | null;
  status: RequestStatus;
  requestDate?: Date;
  createdById: string;
  contactNumber: string;
}

interface DonorRecord {
  userId: string;
  medicalHistory?: string | null;
  address?: string | null;
  [key: string]: unknown;
}

// Return a whitelist DTO so nested patient, donor, and persistence fields cannot leak.
export function serializeRequestForActor(
  record: RequestRecord,
  actor?: AuthContext,
): BloodRequestResponse {
  const canSeeContact =
    actor?.role === "ADMINISTRATOR" || actor?.userId === record.createdById;
  return {
    id: record.id,
    requestType: record.requestType,
    bloodGroup: record.bloodGroup ?? null,
    component: record.component ?? null,
    organType: record.organType ?? null,
    quantity: record.quantity,
    priority: record.priority,
    location: record.location,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    radiusKm: record.radiusKm ?? null,
    status: record.status,
    requestDate: record.requestDate?.toISOString(),
    ...(canSeeContact ? { contactNumber: record.contactNumber } : {}),
  };
}

// Keep match responses stable and limit them to provider and availability details.
export function serializeBloodMatchingResult(input: {
  status: "MATCHES_FOUND" | "NO_MATCH";
  candidates: Array<{
    matchId?: string;
    inventoryId: string;
    institutionId: string;
    institutionName: string;
    unitsAvailable: number;
    expiryDate: Date | null;
    lastUpdated: Date;
    distanceKm?: number;
    freshnessMinutes: number;
    expiryProximityHours?: number;
    score: number;
    guaranteedFulfilment: false;
  }>;
  retry: BloodMatchingResponse["retry"];
}): BloodMatchingResponse {
  return {
    status: input.status,
    candidates: input.candidates.flatMap((candidate) =>
      candidate.matchId
        ? [{
            matchId: candidate.matchId,
            inventoryId: candidate.inventoryId,
            institutionId: candidate.institutionId,
            institutionName: candidate.institutionName,
            unitsAvailable: candidate.unitsAvailable,
            expiryDate: candidate.expiryDate?.toISOString() ?? null,
            lastUpdated: candidate.lastUpdated.toISOString(),
            distanceKm: candidate.distanceKm,
            freshnessMinutes: candidate.freshnessMinutes,
            expiryProximityHours: candidate.expiryProximityHours,
            score: candidate.score,
            guaranteedFulfilment: false as const,
          }]
        : [],
    ),
    retry: input.retry,
  };
}

// Hide donor medical history and address from coordination participants by default.
export function serializeDonorForActor(
  record: DonorRecord,
  actor?: AuthContext,
) {
  const { medicalHistory, address, ...publicRecord } = record;
  const canSeeSensitiveData =
    actor?.role === "ADMINISTRATOR" || actor?.userId === record.userId;

  return canSeeSensitiveData ? record : publicRecord;
}

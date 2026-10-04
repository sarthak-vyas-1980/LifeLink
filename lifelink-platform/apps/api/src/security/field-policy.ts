import type { AuthContext } from "../middleware/auth";

interface RequestRecord {
  createdById: string;
  contactNumber: string;
  [key: string]: unknown;
}

interface DonorRecord {
  userId: string;
  medicalHistory?: string | null;
  address?: string | null;
  [key: string]: unknown;
}

// Hide requester contact details from providers unless the viewer owns the request.
export function serializeRequestForActor(
  record: RequestRecord,
  actor?: AuthContext,
) {
  const { contactNumber, ...publicRecord } = record;
  const canSeeContact =
    actor?.role === "ADMINISTRATOR" || actor?.userId === record.createdById;

  return canSeeContact ? record : publicRecord;
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

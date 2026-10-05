// Write a traceable record for a significant state-changing action.
import { Prisma } from "@prisma/client";
import { appendAuditEvent, findAuditEvents } from "@lifelink/database";

export interface AuditEventInput {
  actorId?: string;
  actorInstitutionId?: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

// Write only safe metadata; credentials, tokens, and medical details never belong here.
export function recordAuditEvent(data: AuditEventInput) {
  return appendAuditEvent(data);
}

export function queryAuditEvents(where: Prisma.AuditLogWhereInput, take = 100) {
  return findAuditEvents(where, take);
}

// Audit records are append-only at the service boundary.
export function protectAuditRecord() {
  throw new Error(
    "Audit records cannot be modified or deleted through the API.",
  );
}

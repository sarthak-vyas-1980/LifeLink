import { Prisma } from "@prisma/client";
import { database } from "../client";

export interface AuditEventInput {
  actorId?: string;
  actorInstitutionId?: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

// Append a traceable record for a significant state-changing action.
export function appendAuditEvent(data: AuditEventInput) {
  return database.auditLog.create({ data });
}

export function findAuditEvents(where: Prisma.AuditLogWhereInput, take = 100) {
  return database.auditLog.findMany({
    where,
    include: { actor: true },
    orderBy: { createdAt: "desc" },
    take,
  });
}

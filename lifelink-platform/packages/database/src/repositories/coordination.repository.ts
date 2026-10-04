import { Prisma } from "@prisma/client";
import { database, runInTransaction } from "../client";

// Execute related coordination writes as one operational transaction.
export function saveCoordinationRecord<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return runInTransaction(operation);
}

export function findCoordinationRecord(requestId: string) {
  return database.request.findUnique({
    where: { id: requestId },
    include: {
      matches: true,
      donations: true,
      allocations: true,
      recipients: true,
    },
  });
}

export function saveCoordinationTransition(
  requestId: string,
  status: Prisma.RequestUpdateInput["status"],
  actorId?: string,
) {
  return runInTransaction(async (transaction) => {
    const request = await transaction.request.update({
      where: { id: requestId },
      data: { status },
    });

    await transaction.auditLog.create({
      data: {
        actorId,
        action: "COORDINATION_STATUS_CHANGED",
        entityType: "Request",
        entityId: requestId,
        metadata: { status: String(status) },
      },
    });

    return request;
  });
}

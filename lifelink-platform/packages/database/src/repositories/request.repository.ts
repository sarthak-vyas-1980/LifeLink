import { Prisma, RequestStatus as PrismaRequestStatus } from "@prisma/client";
import { isAllowedTransition, RequestStatus } from "@lifelink/shared";
import { database, runInTransaction } from "../client";
import { consumeReservedBloodUnits } from "./inventory.repository";
import { recordWorkflowEvent } from "./workflow-event.repository";

export function findRequestById(id: string) {
  return database.request.findUnique({
    where: { id },
    include: {
      createdBy: true,
      recipients: true,
      matches: { include: { providerInstitution: true, bloodInventory: true } },
      donations: true,
      allocations: true,
    },
  });
}

export function createRequest(data: Prisma.RequestCreateInput) {
  return runInTransaction(async (transaction) => {
    const request = await transaction.request.create({ data });
    await recordWorkflowEvent(transaction, {
      eventType:
        request.priority === "EMERGENCY"
          ? "EMERGENCY_REQUEST_CREATED"
          : "REQUEST_CREATED",
      requestId: request.id,
      actorId: request.createdById ?? undefined,
      actorInstitutionId: request.createdByInstitutionId ?? undefined,
      payload: { status: request.status },
    });
    return request;
  });
}

export function searchRequests(where: Prisma.RequestWhereInput, take = 100) {
  return database.request.findMany({
    where,
    orderBy: [{ priority: "desc" }, { requestDate: "asc" }],
    take,
  });
}

export async function saveRequestTransition(
  id: string,
  from: PrismaRequestStatus,
  to: PrismaRequestStatus,
  actorId?: string,
) {
  if (!isAllowedTransition(from as RequestStatus, to as RequestStatus)) {
    throw new Error(`Invalid request transition: ${from} -> ${to}`);
  }

  return runInTransaction(async (transaction) => {
    const result = await transaction.request.updateMany({
      where: { id, status: from },
      data: { status: to },
    });

    if (result.count !== 1) {
      throw new Error("Request state changed or the request does not exist.");
    }

    await transaction.auditLog.create({
      data: {
        actorId,
        action: "REQUEST_STATUS_CHANGED",
        entityType: "Request",
        entityId: id,
        metadata: { from, to },
      },
    });
    await recordWorkflowEvent(transaction, {
      eventType: "REQUEST_STATUS_CHANGED",
      requestId: id,
      actorId,
      payload: { from, to },
    });

    return transaction.request.findUniqueOrThrow({ where: { id } });
  });
}

// Consume the reserved units and close an in-transit blood request atomically.
export function fulfillBloodRequest(
  requestId: string,
  inventoryId: string,
  quantity: number,
  actorId?: string,
) {
  return runInTransaction(async (transaction) => {
    await consumeReservedBloodUnits(
      transaction,
      inventoryId,
      quantity,
      actorId,
    );

    const result = await transaction.request.updateMany({
      where: { id: requestId, status: PrismaRequestStatus.IN_TRANSIT },
      data: { status: PrismaRequestStatus.FULFILLED },
    });

    if (result.count !== 1) {
      throw new Error("Only an in-transit request can be fulfilled.");
    }

    await transaction.auditLog.create({
      data: {
        actorId,
        action: "REQUEST_FULFILLED",
        entityType: "Request",
        entityId: requestId,
        metadata: { inventoryId, quantity },
      },
    });
    await recordWorkflowEvent(transaction, {
      eventType: "REQUEST_STATUS_CHANGED",
      requestId,
      actorId,
      payload: { from: PrismaRequestStatus.IN_TRANSIT, to: PrismaRequestStatus.FULFILLED },
    });

    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

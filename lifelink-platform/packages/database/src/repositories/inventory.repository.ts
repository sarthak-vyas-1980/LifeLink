import {
  BloodComponent,
  BloodGroup,
  BloodInventoryStatus,
  InstitutionStatus,
  InstitutionType,
  Prisma,
} from "@prisma/client";
import { database, runInTransaction } from "../client";

export interface BloodInventorySearchCriteria {
  bloodGroup: BloodGroup;
  component: BloodComponent;
  quantity: number;
  institutionId?: string;
  freshnessMinutes?: number;
}

export function createBloodInventory(data: Prisma.BloodInventoryCreateInput) {
  return database.bloodInventory.create({ data });
}

export function updateBloodInventory(
  id: string,
  data: Prisma.BloodInventoryUpdateInput,
) {
  return database.bloodInventory.update({ where: { id }, data });
}

export async function updateBloodInventoryForInstitution(
  id: string,
  institutionId: string,
  data: Prisma.BloodInventoryUpdateInput,
) {
  const result = await database.bloodInventory.updateMany({
    where: { id, institutionId },
    data,
  });

  if (result.count !== 1) {
    throw new Error("Inventory does not belong to the requesting institution.");
  }

  return database.bloodInventory.findUniqueOrThrow({ where: { id } });
}

// Search authoritative live inventory; geospatial ranking belongs to the matching service.
export function searchAvailableInventory(
  criteria: BloodInventorySearchCriteria,
) {
  return database.bloodInventory.findMany({
    where: {
      bloodGroup: criteria.bloodGroup,
      component: criteria.component,
      status: BloodInventoryStatus.AVAILABLE,
      unitsAvailable: { gte: criteria.quantity },
      institutionId: criteria.institutionId,
      lastUpdated:
        criteria.freshnessMinutes !== undefined
          ? { gte: new Date(Date.now() - criteria.freshnessMinutes * 60_000) }
          : undefined,
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      institution: {
        status: InstitutionStatus.ACTIVE,
        OR: [
          { type: InstitutionType.BLOOD_BANK },
          {
            type: InstitutionType.HOSPITAL,
            hospitalProfile: { is: { bloodService: { isNot: null } } },
          },
        ],
      },
    },
    include: { institution: true },
    orderBy: [{ expiryDate: "asc" }, { lastUpdated: "desc" }],
  });
}

function updateAvailabilityStatus(
  transaction: Prisma.TransactionClient,
  id: string,
) {
  return transaction.bloodInventory
    .findUniqueOrThrow({ where: { id } })
    .then((record) =>
      transaction.bloodInventory.update({
        where: { id },
        data: {
          status:
            record.unitsAvailable > 0
              ? BloodInventoryStatus.AVAILABLE
              : record.reservedUnits > 0
                ? BloodInventoryStatus.RESERVED
                : BloodInventoryStatus.UNAVAILABLE,
        },
      }),
    );
}

export async function reserveBloodUnits(
  transaction: Prisma.TransactionClient,
  id: string,
  quantity: number,
  actorId?: string,
) {
  const result = await transaction.bloodInventory.updateMany({
    where: {
      id,
      status: BloodInventoryStatus.AVAILABLE,
      unitsAvailable: { gte: quantity },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
    },
    data: {
      unitsAvailable: { decrement: quantity },
      reservedUnits: { increment: quantity },
    },
  });

  if (result.count !== 1) {
    throw new Error(
      "Blood inventory is unavailable for the requested reservation.",
    );
  }

  const inventory = await updateAvailabilityStatus(transaction, id);
  await transaction.auditLog.create({
    data: {
      actorId,
      action: "BLOOD_INVENTORY_RESERVED",
      entityType: "BloodInventory",
      entityId: id,
      metadata: { quantity },
    },
  });
  return inventory;
}

export async function releaseReservedBloodUnits(
  transaction: Prisma.TransactionClient,
  id: string,
  quantity: number,
  actorId?: string,
) {
  const result = await transaction.bloodInventory.updateMany({
    where: { id, reservedUnits: { gte: quantity } },
    data: {
      unitsAvailable: { increment: quantity },
      reservedUnits: { decrement: quantity },
    },
  });

  if (result.count !== 1) {
    throw new Error("Reserved blood inventory is insufficient for release.");
  }

  const inventory = await updateAvailabilityStatus(transaction, id);
  await transaction.auditLog.create({
    data: {
      actorId,
      action: "BLOOD_INVENTORY_RELEASED",
      entityType: "BloodInventory",
      entityId: id,
      metadata: { quantity },
    },
  });
  return inventory;
}

export async function consumeReservedBloodUnits(
  transaction: Prisma.TransactionClient,
  id: string,
  quantity: number,
  actorId?: string,
) {
  const result = await transaction.bloodInventory.updateMany({
    where: { id, reservedUnits: { gte: quantity } },
    data: { reservedUnits: { decrement: quantity } },
  });

  if (result.count !== 1) {
    throw new Error(
      "Reserved blood inventory is insufficient for consumption.",
    );
  }

  const inventory = await updateAvailabilityStatus(transaction, id);
  await transaction.auditLog.create({
    data: {
      actorId,
      action: "BLOOD_INVENTORY_CONSUMED",
      entityType: "BloodInventory",
      entityId: id,
      metadata: { quantity },
    },
  });
  return inventory;
}

export function updateInventoryTransactionally<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return runInTransaction(operation);
}

export function reserveBloodInventory(
  id: string,
  quantity: number,
  actorId?: string,
) {
  return runInTransaction((transaction) =>
    reserveBloodUnits(transaction, id, quantity, actorId),
  );
}

export function releaseBloodInventory(
  id: string,
  quantity: number,
  actorId?: string,
) {
  return runInTransaction((transaction) =>
    releaseReservedBloodUnits(transaction, id, quantity, actorId),
  );
}

export function consumeBloodInventory(
  id: string,
  quantity: number,
  actorId?: string,
) {
  return runInTransaction((transaction) =>
    consumeReservedBloodUnits(transaction, id, quantity, actorId),
  );
}

export function markInventoryStale() {
  return database.bloodInventory.updateMany({
    where: {
      status: BloodInventoryStatus.AVAILABLE,
      expiryDate: { lt: new Date() },
    },
    data: { status: BloodInventoryStatus.EXPIRED },
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { reserveBloodUnits, releaseReservedBloodUnits, consumeReservedBloodUnits } from "../../packages/database/src/repositories/inventory.repository";

function makeTransaction(initial = 5) {
  const inventory = { unitsAvailable: initial, reservedUnits: 0, status: "AVAILABLE", expiryDate: null as Date | null };
  const transaction = {
    bloodInventory: {
      updateMany: async ({ where, data }: any) => {
        if (where.unitsAvailable && inventory.unitsAvailable < where.unitsAvailable.gte) return { count: 0 };
        if (where.reservedUnits && inventory.reservedUnits < where.reservedUnits.gte) return { count: 0 };
        if (where.status && inventory.status !== where.status) return { count: 0 };
        if (data.unitsAvailable?.decrement) inventory.unitsAvailable -= data.unitsAvailable.decrement;
        if (data.unitsAvailable?.increment) inventory.unitsAvailable += data.unitsAvailable.increment;
        if (data.reservedUnits?.increment) inventory.reservedUnits += data.reservedUnits.increment;
        if (data.reservedUnits?.decrement) inventory.reservedUnits -= data.reservedUnits.decrement;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...inventory }),
      update: async ({ data }: any) => { inventory.status = data.status; return { ...inventory }; },
    },
    auditLog: { create: async () => ({}) },
  };
  return { inventory, transaction: transaction as never };
}

test("reservation cannot drive available blood below zero", async () => {
  const { inventory, transaction } = makeTransaction(5);
  await reserveBloodUnits(transaction, "inventory", 4);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [1, 4]);
  await assert.rejects(reserveBloodUnits(transaction, "inventory", 2), /unavailable/);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [1, 4]);
});

test("release restores availability and consumption only uses reserved units", async () => {
  const { inventory, transaction } = makeTransaction(5);
  await reserveBloodUnits(transaction, "inventory", 3);
  await releaseReservedBloodUnits(transaction, "inventory", 1);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [3, 2]);
  await consumeReservedBloodUnits(transaction, "inventory", 2);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [3, 0]);
  await assert.rejects(consumeReservedBloodUnits(transaction, "inventory", 1), /insufficient/);
  assert.deepEqual([inventory.unitsAvailable, inventory.reservedUnits], [3, 0]);
});

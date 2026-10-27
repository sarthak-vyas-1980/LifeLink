import assert from "node:assert/strict";
import test from "node:test";
import { recordCompletedDonationInventory } from "../../apps/api/src/modules/donations/routes";

test("UT-DON-01 completed screened donation adds and links exactly one whole-blood unit using the verified group", async () => {
  const inventoryCreates: any[] = [];
  const donationLinks: any[] = [];
  const tx = {
    bloodInventory: { create: async ({ data }: any) => { inventoryCreates.push(data); return { id: "inventory-1", ...data }; } },
    donationInventory: { create: async ({ data }: any) => { donationLinks.push(data); return data; } },
  } as never;
  const expiryDate = new Date("2027-04-03T00:00:00.000Z");
  const result = await recordCompletedDonationInventory(tx, {
    donationId: "donation-1", institutionId: "institution-1", verifiedBloodGroup: "AB_POSITIVE", expiryDate,
  });

  assert.equal(inventoryCreates.length, 1);
  assert.deepEqual(inventoryCreates[0], {
    institutionId: "institution-1", bloodGroup: "AB_POSITIVE", component: "WHOLE_BLOOD",
    unitsAvailable: 1, status: "AVAILABLE", expiryDate,
  });
  assert.deepEqual(donationLinks, [{
    donationId: "donation-1", bloodInventoryId: "inventory-1", bloodGroup: "AB_POSITIVE",
    quantity: 1, expiryDate, status: "AVAILABLE",
  }]);
  assert.equal(result.id, "inventory-1");
});

test("UT-DON-02 inventory linkage failure propagates so completion can roll back transactionally", async () => {
  const tx = {
    bloodInventory: { create: async () => ({ id: "inventory-1" }) },
    donationInventory: { create: async () => { throw new Error("link failed"); } },
  } as never;
  await assert.rejects(recordCompletedDonationInventory(tx, {
    donationId: "donation-1", institutionId: "institution-1", verifiedBloodGroup: "O_NEGATIVE", expiryDate: new Date("2027-01-01"),
  }), /link failed/);
});

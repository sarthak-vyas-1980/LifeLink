import { DonationStatus, Prisma } from "@prisma/client";
import { database, runInTransaction } from "../client";

// Persist donor pledges and institution responses.
export function createDonation(data: Prisma.DonationCreateInput) {
  return database.donation.create({ data });
}

export function findDonationsForRequest(requestId: string) {
  return database.donation.findMany({
    where: { requestId },
    include: { donor: true, inventoryItems: true, providerInstitution: true },
    orderBy: { createdAt: "asc" },
  });
}

export function updateDonationStatus(id: string, status: DonationStatus) {
  return runInTransaction(async (transaction) => {
    const donation = await transaction.donation.update({
      where: { id },
      data: { status },
    });

    await transaction.auditLog.create({
      data: {
        action: "DONATION_STATUS_CHANGED",
        entityType: "Donation",
        entityId: id,
        metadata: { status },
      },
    });

    return donation;
  });
}

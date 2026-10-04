import { MatchStatus, Prisma } from "@prisma/client";
import { database, runInTransaction } from "../client";

// Persist candidate matches separately from guaranteed fulfilment.
export function createMatch(data: Prisma.MatchCreateInput) {
  return database.match.create({ data });
}

export function findMatchesForRequest(requestId: string) {
  return database.match.findMany({
    where: { requestId },
    include: {
      providerInstitution: true,
      bloodInventory: true,
      organInventory: true,
    },
    orderBy: [
      { status: "asc" },
      { compatibilityScore: "desc" },
      { matchedDate: "asc" },
    ],
  });
}

export function updateMatchStatus(id: string, status: MatchStatus) {
  return runInTransaction(async (transaction) => {
    const match = await transaction.match.update({
      where: { id },
      data: { status },
    });

    await transaction.auditLog.create({
      data: {
        action: "MATCH_STATUS_CHANGED",
        entityType: "Match",
        entityId: id,
        metadata: { status },
      },
    });

    return match;
  });
}

export function deleteExpiredMatches(before: Date) {
  return database.match.updateMany({
    where: { status: MatchStatus.PENDING, matchedDate: { lt: before } },
    data: { status: MatchStatus.EXPIRED },
  });
}

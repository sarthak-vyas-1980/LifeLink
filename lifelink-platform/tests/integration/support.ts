import type { PrismaClient } from "@prisma/client";

// Integration suites write and delete real rows, so they only run against a disposable database.
export const testDatabaseUrl = process.env.LIFELINK_TEST_DATABASE_URL?.trim();
export const skipReason: string | false = testDatabaseUrl
  ? false
  : "Set LIFELINK_TEST_DATABASE_URL to a disposable, migrated PostgreSQL database to run this suite.";

export function useTestDatabase() {
  if (!testDatabaseUrl) throw new Error("LIFELINK_TEST_DATABASE_URL is not set.");
  let host = "";
  try { host = new URL(testDatabaseUrl).hostname; } catch { /* reported below */ }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost") || host.endsWith(".test");
  if (!local && process.env.LIFELINK_TEST_DATABASE_ALLOW_REMOTE !== "YES") {
    throw new Error(`Refusing to run integration tests against "${host || "an unreadable URL"}". Use a local disposable database, or set LIFELINK_TEST_DATABASE_ALLOW_REMOTE=YES for a dedicated remote test database.`);
  }
  process.env.DATABASE_URL = testDatabaseUrl;
}

export interface CreatedRecords {
  users: string[];
  institutions: string[];
  requests: string[];
  inventory: string[];
}

export function createdRecords(): CreatedRecords {
  return { users: [], institutions: [], requests: [], inventory: [] };
}

// Remove everything a blood or HTTP suite created, children before parents.
export async function cleanupBloodRecords(database: PrismaClient, created: CreatedRecords) {
  const { users, institutions } = created;
  const requests = (await database.request.findMany({
    where: { OR: [{ id: { in: created.requests } }, { createdById: { in: users } }, { createdByInstitutionId: { in: institutions } }] },
    select: { id: true },
  })).map(({ id }) => id);
  const inventory = (await database.bloodInventory.findMany({
    where: { OR: [{ id: { in: created.inventory } }, { institutionId: { in: institutions } }] },
    select: { id: true },
  })).map(({ id }) => id);
  const matches = (await database.match.findMany({
    where: { OR: [{ requestId: { in: requests } }, { bloodInventoryId: { in: inventory } }] },
    select: { id: true },
  })).map(({ id }) => id);
  const donations = (await database.donation.findMany({
    where: { OR: [{ donorId: { in: users } }, { providerInstitutionId: { in: institutions } }, { requestId: { in: requests } }] },
    select: { id: true },
  })).map(({ id }) => id);
  const events = (await database.workflowEvent.findMany({
    where: { OR: [{ requestId: { in: requests } }, { actorId: { in: users } }, { actorInstitutionId: { in: institutions } }] },
    select: { id: true },
  })).map(({ id }) => id);

  await database.notification.deleteMany({ where: { OR: [{ eventId: { in: events } }, { requestId: { in: requests } }, { userId: { in: users } }, { institutionId: { in: institutions } }] } });
  await database.workflowEvent.deleteMany({ where: { id: { in: events } } });
  await database.auditLog.deleteMany({
    where: { OR: [{ actorId: { in: users } }, { actorInstitutionId: { in: institutions } }, { entityId: { in: [...requests, ...inventory, ...matches, ...donations, ...users, ...institutions] } }] },
  });
  await database.donation.deleteMany({ where: { id: { in: donations } } });
  await database.match.deleteMany({ where: { id: { in: matches } } });
  await database.request.deleteMany({ where: { id: { in: requests } } });
  await database.bloodInventory.deleteMany({ where: { id: { in: inventory } } });
  await database.user.deleteMany({ where: { id: { in: users } } });
  await database.institution.deleteMany({ where: { id: { in: institutions } } });
}

export function rejectsWith(status: number, code?: string) {
  return (error: any) => error?.status === status && (code === undefined || error.code === code);
}

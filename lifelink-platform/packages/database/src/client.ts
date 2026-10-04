import { Prisma, PrismaClient } from "@prisma/client";

export const database = new PrismaClient();

// Expose the process-wide operational client to repositories and services.
export function createDatabaseClient() {
  return database;
}

// Run related state changes in one database transaction.
export function runInTransaction<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return database.$transaction(operation);
}

// Close the database client during application shutdown.
export async function disconnectDatabase() {
  await database.$disconnect();
}

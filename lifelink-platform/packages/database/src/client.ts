import { Prisma, PrismaClient } from "@prisma/client";

export const database = new PrismaClient();

const raw$transaction = database.$transaction.bind(database);
(database as any).$transaction = (arg: any, options?: any) => {
  if (typeof arg === "function") {
    return raw$transaction(arg, {
      maxWait: 10000,
      timeout: 25000,
      ...options,
    });
  }
  return raw$transaction(arg, options);
};

// Expose the process-wide operational client to repositories and services.
export function createDatabaseClient() {
  return database;
}

export function runInTransaction<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return database.$transaction(operation, {
    maxWait: 10000,
    timeout: 25000,
  });
}

// Close the database client during application shutdown.
export async function disconnectDatabase() {
  await database.$disconnect();
}

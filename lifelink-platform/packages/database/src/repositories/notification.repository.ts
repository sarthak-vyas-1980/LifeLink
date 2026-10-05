import { NotificationStatus } from "@prisma/client";
import { database } from "../client";

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

// Read a user's inbox using a stable timestamp/id cursor for reconnect replay.
export function findNotificationsForUser(
  userId: string,
  options: {
    after?: NotificationCursor;
    unreadOnly?: boolean;
    take?: number;
  } = {},
) {
  return database.notification.findMany({
    where: {
      userId,
      status: options.unreadOnly ? NotificationStatus.UNREAD : undefined,
      ...(options.after
        ? {
            OR: [
              { createdAt: { gt: options.after.createdAt } },
              {
                createdAt: options.after.createdAt,
                id: { gt: options.after.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(options.take ?? 50, 1), 100) + 1,
  });
}

export function findNotificationsForInstitution(
  institutionId: string,
  options: { after?: NotificationCursor; unreadOnly?: boolean; take?: number } = {},
) {
  return database.notification.findMany({
    where: {
      institutionId,
      status: options.unreadOnly ? NotificationStatus.UNREAD : undefined,
      ...(options.after ? { OR: [
        { createdAt: { gt: options.after.createdAt } },
        { createdAt: options.after.createdAt, id: { gt: options.after.id } },
      ] } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(options.take ?? 50, 1), 100) + 1,
  });
}

// Change read state only when the notification belongs to the current user.
export async function markNotificationRead(userId: string, notificationId: string) {
  const result = await database.notification.updateMany({
    where: { id: notificationId, userId },
    data: { status: NotificationStatus.READ },
  });
  return result.count === 1;
}

export async function markInstitutionNotificationRead(institutionId: string, notificationId: string) {
  const result = await database.notification.updateMany({
    where: { id: notificationId, institutionId },
    data: { status: NotificationStatus.READ },
  });
  return result.count === 1;
}

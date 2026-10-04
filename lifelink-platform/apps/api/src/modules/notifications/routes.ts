import { Router, type Request, type RequestHandler, type Response } from "express";
import { findNotificationsForUser, markNotificationRead } from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";

// Expose only the authenticated user's inbox and persisted reconnect stream.
export function registerNotificationRoutes(router = Router()) {
  router.use(authenticateRequest());
  router.get("/", asyncRoute(listNotifications));
  router.get("/sync", asyncRoute(synchronizeNotifications));
  router.post("/:notificationId/read", asyncRoute(updateNotificationStatus));
  return router;
}

export async function listNotifications(request: Request, response: Response) {
  const take = readTake(request.query.limit);
  if (take === undefined) {
    response.status(400).json({ code: "INVALID_LIMIT", message: "Limit must be from 1 to 100." });
    return;
  }
  const rows = await findNotificationsForUser(request.auth!.userId, {
    unreadOnly: request.query.unread === "true",
    take,
  });
  response.json({ notifications: rows.slice(0, take), hasMore: rows.length > take });
}

// Reconnect recovery reads ordered notification rows directly from PostgreSQL.
export async function synchronizeNotifications(request: Request, response: Response) {
  const take = readTake(request.query.limit) ?? 50;
  const cursor = parseCursor(request.query.afterCreatedAt, request.query.afterId);
  if (cursor === null) {
    response.status(400).json({
      code: "INVALID_CURSOR",
      message: "Both afterCreatedAt and afterId must identify a valid cursor.",
    });
    return;
  }
  const rows = await findNotificationsForUser(request.auth!.userId, {
    after: cursor ?? undefined,
    take,
  });
  const hasMore = rows.length > take;
  const notifications = rows.slice(0, take);
  const last = notifications.at(-1);
  response.json({
    notifications,
    nextCursor: last
      ? { createdAt: last.createdAt.toISOString(), id: last.id }
      : cursor
        ? { createdAt: cursor.createdAt.toISOString(), id: cursor.id }
        : null,
    hasMore,
  });
}

// The user ID always comes from the authenticated token, never the request body.
export async function updateNotificationStatus(request: Request, response: Response) {
  const updated = await markNotificationRead(
    request.auth!.userId,
    String(request.params.notificationId),
  );
  if (!updated) {
    response.status(404).json({ code: "NOTIFICATION_NOT_FOUND", message: "Notification not found." });
    return;
  }
  response.status(204).end();
}

function readTake(value: unknown) {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const take = Number(value);
  return take >= 1 && take <= 100 ? take : undefined;
}

function parseCursor(createdAtValue: unknown, idValue: unknown) {
  if (createdAtValue === undefined && idValue === undefined) return undefined;
  if (typeof createdAtValue !== "string" || typeof idValue !== "string" || idValue.length > 64) {
    return null;
  }
  const createdAt = new Date(createdAtValue);
  if (!Number.isFinite(createdAt.getTime())) return null;
  return { createdAt, id: idValue };
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import Redis from "ioredis";
import { authenticateSocketToken, type AuthContext } from "../../middleware/auth";
import { getRuntimeConfig } from "../../config";
import { database, findNotificationsForUser } from "@lifelink/database";

const channel = "lifelink:workflow-events:v1";
const seenEventIds = new Set<string>();
let io: Server | undefined;
let publisher: Redis | undefined;
let subscriber: Redis | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
let dispatching = false;

interface RealtimeEvent {
  eventId: string;
  eventType: string;
  requestId: string | null;
  payload: unknown;
  createdAt: string;
  recipients: Array<{ userId: string; notificationId: string }>;
}

export function rememberEventForDelivery(eventId: string) {
  if (seenEventIds.has(eventId)) return false;
  seenEventIds.add(eventId);
  if (seenEventIds.size > 10_000) {
    const oldest = seenEventIds.values().next().value;
    if (oldest) seenEventIds.delete(oldest);
  }
  return true;
}

function deliverToLocalParticipants(event: RealtimeEvent) {
  if (!io || !rememberEventForDelivery(event.eventId)) return;
  for (const recipient of event.recipients) {
    io.to(userRoom(recipient.userId)).emit("workflow:event", {
      eventId: event.eventId,
      eventType: event.eventType,
      requestId: event.requestId,
      payload: event.payload,
      createdAt: event.createdAt,
      cursor: { createdAt: event.createdAt, id: recipient.notificationId },
    });
  }
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

function authenticateSocket(socket: Socket, next: (error?: Error) => void) {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || token.length === 0) {
    next(new Error("Authentication required."));
    return;
  }
  try {
    const auth = authenticateSocketToken(token);
    socket.data.auth = auth;
    next();
  } catch {
    next(new Error("Invalid authentication token."));
  }
}

function actorFromSocket(socket: Socket): AuthContext {
  return socket.data.auth as AuthContext;
}

// Attach authenticated per-user rooms and PostgreSQL-backed replay to Socket.IO.
export async function registerRealtimeGateway(httpServer: HttpServer) {
  io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  io.use(authenticateSocket);
  io.on("connection", (socket) => {
    const actor = actorFromSocket(socket);
    socket.join(userRoom(actor.userId));
    socket.on("workflow:sync", async (input: unknown, acknowledge?: (data: unknown) => void) => {
      if (typeof acknowledge !== "function") return;
      try {
        const cursor = readCursor(input);
        const rows = await findNotificationsForUser(actor.userId, {
          after: cursor,
          take: 100,
        });
        const hasMore = rows.length > 100;
        const page = rows.slice(0, 100);
        const last = page.at(-1);
        acknowledge({
        events: page.map(notificationToEvent),
          nextCursor: last
            ? { createdAt: last.createdAt.toISOString(), id: last.id }
            : cursor
              ? { createdAt: cursor.createdAt.toISOString(), id: cursor.id }
              : null,
          hasMore,
        });
      } catch {
        acknowledge({ code: "SYNC_FAILED", message: "Could not synchronize workflow updates." });
      }
    });
  });

  const { redisUrl } = getRuntimeConfig();
  if (redisUrl) {
    publisher = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    subscriber = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(channel);
    subscriber.on("message", (receivedChannel, message) => {
      if (receivedChannel !== channel) return;
      try {
        deliverToLocalParticipants(JSON.parse(message) as RealtimeEvent);
      } catch {
        console.error("LifeLink ignored an invalid realtime event message.");
      }
    });
  }

  poller = setInterval(() => {
    void publishPendingEvents().catch((error: unknown) => {
      console.error(
        "LifeLink workflow event relay failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }, 1_000);
  poller.unref?.();
  await publishPendingEvents();
  return io;
}

// Replay unsent PostgreSQL outbox rows; Redis fans out across API instances.
export async function publishPendingEvents() {
  if (dispatching || !io) return;
  dispatching = true;
  try {
    const pending = await database.workflowEvent.findMany({
      where: { publishedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    for (const event of pending) {
      const notifications = await database.notification.findMany({
        where: { eventId: event.id },
        select: { id: true, userId: true },
      });
      const envelope: RealtimeEvent = {
        eventId: event.id,
        eventType: event.eventType,
        requestId: event.requestId,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
        recipients: notifications.map((notification) => ({
          userId: notification.userId,
          notificationId: notification.id,
        })),
      };
      if (publisher) {
        await publisher.publish(channel, JSON.stringify(envelope));
      } else {
        deliverToLocalParticipants(envelope);
      }
      await database.workflowEvent.updateMany({
        where: { id: event.id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
  } finally {
    dispatching = false;
  }
}

// Read a bounded replay cursor from a client message without trusting its user ID.
function readCursor(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const value = input as { createdAt?: unknown; id?: unknown };
  if (typeof value.createdAt !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || value.id.length > 64) return undefined;
  return { createdAt, id: value.id };
}

function notificationToEvent(notification: {
  id: string;
  eventId: string | null;
  eventType: string | null;
  requestId: string | null;
  title: string;
  message: string;
  payload: unknown;
    status: string;
    createdAt: Date;
}) {
  return {
    eventId: notification.eventId ?? notification.id,
    eventType: notification.eventType ?? "NOTIFICATION",
    requestId: notification.requestId,
    title: notification.title,
    message: notification.message,
    payload: notification.payload,
    status: notification.status,
    createdAt: notification.createdAt.toISOString(),
    cursor: { createdAt: notification.createdAt.toISOString(), id: notification.id },
  };
}

// Release Socket.IO and Redis resources during graceful shutdown.
export async function stopRealtimeGateway() {
  if (poller) clearInterval(poller);
  poller = undefined;
  if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = undefined;
  await Promise.all([publisher?.quit(), subscriber?.quit()]);
  publisher = undefined;
  subscriber = undefined;
}

import { io, type Socket } from "socket.io-client";

export interface WorkflowEvent {
  eventId: string;
  eventType: string;
  requestId: string | null;
  payload: unknown;
  createdAt: string;
  cursor: { createdAt: string; id: string };
  title?: string;
  message?: string;
  status?: string;
}

type WorkflowListener = (event: WorkflowEvent) => void;

let socket: Socket | undefined;
let cursor: WorkflowEvent["cursor"] | undefined;
const listeners = new Set<WorkflowListener>();
const processed = new Set<string>();

// Open an authenticated realtime connection; server rooms are scoped per user.
export function connectRealtime(token: string) {
  if (typeof window === "undefined" || !token) return undefined;
  if (socket) {
    socket.auth = { token };
    if (!socket.connected) socket.connect();
    return socket;
  }

  const endpoint = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  socket = io(endpoint, { auth: { token }, autoConnect: false, transports: ["websocket", "polling"] });
  socket.on("connect", () => void synchronizeRealtimeState());
  socket.on("workflow:event", receiveEvent);
  socket.connect();
  return socket;
}

// Subscribe to idempotent workflow updates and return an unsubscribe function.
export function subscribeToWorkflowEvents(listener: WorkflowListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Replay missed updates from PostgreSQL through the authenticated socket.
export async function synchronizeRealtimeState() {
  if (!socket?.connected) return;
  let hasMore = true;
  while (hasMore) {
    const page = await new Promise<{
      events: WorkflowEvent[];
      nextCursor: WorkflowEvent["cursor"] | null;
      hasMore: boolean;
    }>((resolve, reject) => {
      socket!.timeout(10_000).emit(
        "workflow:sync",
        cursor ?? null,
        (error: Error | null, response: { events?: WorkflowEvent[]; nextCursor?: WorkflowEvent["cursor"] | null; hasMore?: boolean; code?: string }) => {
          if (error || !response || response.code) {
            reject(error ?? new Error("Workflow synchronization failed."));
            return;
          }
          resolve({
            events: response.events ?? [],
            nextCursor: response.nextCursor ?? null,
            hasMore: response.hasMore ?? false,
          });
        },
      );
    });
    for (const event of page.events) receiveEvent(event);
    cursor = page.nextCursor ?? cursor;
    hasMore = page.hasMore;
  }
}

// Clear session-bound state on logout so another account cannot reuse the stream.
export function disconnectRealtime() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = undefined;
  cursor = undefined;
  processed.clear();
  listeners.clear();
}

function receiveEvent(event: WorkflowEvent) {
  if (!event?.eventId || processed.has(event.eventId)) return;
  processed.add(event.eventId);
  if (processed.size > 10_000) {
    const oldest = processed.values().next().value;
    if (oldest) processed.delete(oldest);
  }
  if (event.cursor) cursor = event.cursor;
  for (const listener of listeners) listener(event);
}

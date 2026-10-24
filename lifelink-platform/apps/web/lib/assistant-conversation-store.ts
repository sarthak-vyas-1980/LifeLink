import type { AssistantResult, ChatMessage } from "../components/assistant/conversation-types";

const version = 1;
const maxMessages = 60;
const maxStoredAgeMs = 7 * 24 * 60 * 60 * 1000;

export interface ConversationSnapshot {
  ownerId: string;
  conversationId: string;
  updatedAt: number;
  messages: ChatMessage[];
  draft: string;
}

export type ConversationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function assistantConversationStorageKey(ownerId: string) {
  return `lifelink.assistant.conversation.v${version}:${encodeURIComponent(ownerId)}`;
}

export function assistantActiveConversationStorageKey(ownerId: string) {
  return `lifelink.assistant.active-conversation.v${version}:${encodeURIComponent(ownerId)}`;
}

function validResult(value: unknown): value is AssistantResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<AssistantResult>;
  return typeof result.answer === "string" && typeof result.intent === "string" &&
    typeof result.knowledgeUsed === "boolean" && typeof result.liveDataUsed === "boolean" &&
    Array.isArray(result.sources) && Array.isArray(result.limitations);
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-maxMessages).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<ChatMessage> & { deliveryStatus?: string };
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string") return [];
    const wasSending = row.deliveryStatus === "sending";
    return [{
      id: typeof row.id === "string" ? row.id : `restored-${index}`,
      role: row.role,
      content: row.content.slice(0, row.role === "user" ? 2_000 : 30_000),
      ...(validResult(row.result) ? { result: row.result } : {}),
      ...(Boolean(row.failed) || wasSending ? { failed: true } : {}),
      ...(typeof row.errorMessage === "string" ? { errorMessage: row.errorMessage.slice(0, 500) }
        : wasSending ? { errorMessage: "This message was still being sent when the page refreshed. Retry it to continue." } : {}),
    }];
  });
}

export function readAssistantConversation(storage: ConversationStorage, ownerId: string, now = Date.now()): ConversationSnapshot | null {
  try {
    const raw = storage.getItem(assistantConversationStorageKey(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ConversationSnapshot> & { version?: number; messages?: unknown };
    if (value.version !== version || value.ownerId !== ownerId || typeof value.updatedAt !== "number" ||
        now - value.updatedAt > maxStoredAgeMs || typeof value.conversationId !== "string") {
      storage.removeItem(assistantConversationStorageKey(ownerId));
      return null;
    }
    return {
      ownerId, conversationId: value.conversationId, updatedAt: value.updatedAt,
      messages: normalizeMessages(value.messages), draft: typeof value.draft === "string" ? value.draft.slice(0, 2_000) : "",
    };
  } catch { return null; }
}

export function writeAssistantConversation(storage: ConversationStorage, snapshot: ConversationSnapshot): boolean {
  try {
    storage.setItem(assistantConversationStorageKey(snapshot.ownerId), JSON.stringify({ ...snapshot, version }));
    return true;
  } catch { return false; }
}

export function clearAssistantConversation(storage: ConversationStorage, ownerId: string) {
  try { storage.removeItem(assistantConversationStorageKey(ownerId)); } catch { /* Storage can be unavailable in restricted browser contexts. */ }
}

export function clearAssistantActiveConversation(storage: ConversationStorage, ownerId: string) {
  try { storage.removeItem(assistantActiveConversationStorageKey(ownerId)); } catch { /* Storage can be unavailable in restricted browser contexts. */ }
}

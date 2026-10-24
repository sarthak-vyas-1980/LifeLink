"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentSession } from "../../lib/auth";
import { ApiFailure, requestApi } from "../../lib/api-client";
import { assistantActiveConversationStorageKey } from "../../lib/assistant-conversation-store";
import type { AssistantResult, ChatMessage, ConversationSummary } from "./conversation-types";

interface ConversationContextValue {
  messages: ChatMessage[]; conversations: ConversationSummary[]; draft: string; setDraft: (value: string) => void;
  restored: boolean; listLoading: boolean; pendingMessageId: string | null; persistenceWarning: string | null;
  conversationId: string | null; searchConversations: (query: string) => Promise<void>;
  createConversation: () => Promise<void>; selectConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>; deleteConversation: (id: string) => Promise<void>;
  sendMessage: (value: string, retryMessageId?: string) => Promise<void>;
  appendAssistantResult: (answer: string, result: AssistantResult, persistedResult?: AssistantResult) => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);
const newId = () => crypto.randomUUID();

export function AssistantConversationProvider({ children }: { children: ReactNode }) {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const activeConversationRef = useRef<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, string | null>>({});
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const sending = useRef(new Set<string>());
  const creatingConversation = useRef(false);
  const searchRef = useRef("");

  const setActiveMessages = useCallback((id: string, next: ChatMessage[]) => {
    if (activeConversationRef.current !== id) return;
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const setActiveConversation = useCallback((id: string | null) => {
    activeConversationRef.current = id;
    setConversationId(id);
    messagesRef.current = [];
    setMessages([]);
    setDraft("");
    setPersistenceWarning(null);
    const owner = ownerId;
    if (owner && id) {
      try { localStorage.setItem(assistantActiveConversationStorageKey(owner), id); }
      catch { setPersistenceWarning("Your active chat could not be remembered in this browser. It remains saved to your account."); }
    }
  }, [ownerId]);

  const searchConversations = useCallback(async (query: string) => {
    searchRef.current = query;
    setListLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      const suffix = params.size ? `?${params}` : "";
      const result = await requestApi<{ conversations: ConversationSummary[] }>(`/api/rag/conversations${suffix}`);
      setConversations(result.conversations);
    } catch (cause) {
      setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "Chat history could not be loaded.");
    } finally { setListLoading(false); }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    setActiveConversation(id);
    setRestored(false);
    try {
      const result = await requestApi<{ conversation: { id: string; messages: ChatMessage[] } }>(`/api/rag/conversations/${encodeURIComponent(id)}`);
      setActiveMessages(id, result.conversation.messages);
      setPersistenceWarning(null);
    } catch (cause) {
      if (activeConversationRef.current === id) setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "This conversation could not be opened.");
    } finally { if (activeConversationRef.current === id) setRestored(true); }
  }, [setActiveConversation, setActiveMessages]);

  const createConversation = useCallback(async () => {
    if (!ownerId || creatingConversation.current) return;
    creatingConversation.current = true;
    try {
      const result = await requestApi<{ conversation: ConversationSummary }>("/api/rag/conversations", { method: "POST", body: JSON.stringify({}) });
      setConversations((current) => [result.conversation, ...current.filter((item) => item.id !== result.conversation.id)]);
      setActiveConversation(result.conversation.id);
      setRestored(true);
    } catch (cause) {
      setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "A new chat could not be created.");
    } finally { creatingConversation.current = false; }
  }, [ownerId, setActiveConversation]);

  const selectConversation = useCallback(async (id: string) => {
    if (id === activeConversationRef.current && restored) return;
    await loadConversation(id);
  }, [loadConversation, restored]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const result = await requestApi<{ conversation: { id: string; title: string; updatedAt: string } }>(`/api/rag/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ title }),
    });
    setConversations((current) => current.map((item) => item.id === id ? { ...item, title: result.conversation.title, updatedAt: result.conversation.updatedAt } : item));
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    await requestApi<void>(`/api/rag/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    let remaining = conversations.filter((item) => item.id !== id);
    try {
      const params = new URLSearchParams();
      if (searchRef.current.trim()) params.set("q", searchRef.current.trim());
      const suffix = params.size ? `?${params}` : "";
      const refreshed = await requestApi<{ conversations: ConversationSummary[] }>(`/api/rag/conversations${suffix}`);
      remaining = refreshed.conversations;
    } catch { /* The deleted row is removed locally even if refreshing the list fails. */ }
    setConversations(remaining);
    if (activeConversationRef.current === id) {
      if (remaining[0]) await loadConversation(remaining[0].id);
      else await createConversation();
    }
  }, [conversations, createConversation, loadConversation]);

  useEffect(() => {
    const session = getCurrentSession();
    const id = session?.user.id ?? null;
    setOwnerId(id);
    if (!id) { setRestored(true); return; }
    let cancelled = false;
    void (async () => {
      try {
        const result = await requestApi<{ conversations: ConversationSummary[] }>("/api/rag/conversations");
        if (cancelled) return;
        setConversations(result.conversations);
        let remembered: string | null = null;
        try { remembered = localStorage.getItem(assistantActiveConversationStorageKey(id)); } catch { /* History remains server-backed. */ }
        const initial = result.conversations.find((item) => item.id === remembered) ?? result.conversations[0];
        if (initial) await loadConversation(initial.id);
        else await createConversation();
      } catch (cause) {
        if (!cancelled) setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "Chat history could not be restored. Check the connection and retry.");
      } finally { if (!cancelled) setRestored(true); }
    })();
    return () => { cancelled = true; };
  }, [createConversation, loadConversation]);

  const sendMessage = useCallback(async (value: string, retryMessageId?: string) => {
    if (!ownerId) return;
    let targetId = activeConversationRef.current;
    if (!targetId) {
      let created: { conversation: ConversationSummary };
      try { created = await requestApi<{ conversation: ConversationSummary }>("/api/rag/conversations", { method: "POST", body: JSON.stringify({}) }); }
      catch (cause) { setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "A new chat could not be created."); return; }
      targetId = created.conversation.id;
      setConversations((current) => [created.conversation, ...current]);
      setActiveConversation(targetId);
      setRestored(true);
    }
    if (sending.current.has(targetId)) return;
    const message = (retryMessageId ? messagesRef.current.find((item) => item.id === retryMessageId)?.content ?? "" : value).trim();
    if (!message) return;
    sending.current.add(targetId);
    const userMessageId = retryMessageId ?? newId();
    if (retryMessageId) {
      setActiveMessages(targetId, messagesRef.current.map((item) => item.id === retryMessageId ? { ...item, failed: false, errorMessage: undefined, deliveryStatus: "sending" } : item));
    } else {
      setActiveMessages(targetId, [...messagesRef.current, { id: userMessageId, role: "user", content: message, deliveryStatus: "sending" }]);
      setDraft("");
    }
    setPendingByConversation((current) => ({ ...current, [targetId!]: userMessageId }));
    try {
      const response = await requestApi<{ result: AssistantResult & { messageId: string; answeredAt?: string } }>(`/api/rag/conversations/${encodeURIComponent(targetId)}/messages`, {
        method: "POST", body: JSON.stringify({ clientMessageId: userMessageId, message }),
      });
      if (activeConversationRef.current === targetId) {
        setActiveMessages(targetId, [
          ...messagesRef.current.map((item) => item.id === userMessageId ? { ...item, deliveryStatus: undefined } : item),
          { id: response.result.messageId, role: "assistant", content: response.result.answer, result: response.result, createdAt: response.result.answeredAt },
        ]);
      }
      void searchConversations(searchRef.current);
    } catch (cause) {
      const detail = cause instanceof ApiFailure ? cause.message : "The assistant couldn't connect just now. Check your connection and try again.";
      if (activeConversationRef.current === targetId) setActiveMessages(targetId, messagesRef.current.map((item) => item.id === userMessageId
        ? { ...item, failed: true, deliveryStatus: "failed", errorMessage: detail } : item));
    } finally {
      sending.current.delete(targetId);
      setPendingByConversation((current) => ({ ...current, [targetId!]: null }));
    }
  }, [ownerId, searchConversations, setActiveConversation, setActiveMessages]);

  const appendAssistantResult = useCallback(async (answer: string, result: AssistantResult, persistedResult: AssistantResult = result) => {
    const targetId = activeConversationRef.current;
    if (!targetId) return;
    const clientMessageId = newId();
    try {
      const response = await requestApi<{ message: ChatMessage }>(`/api/rag/conversations/${encodeURIComponent(targetId)}/events`, {
        method: "POST", body: JSON.stringify({ clientMessageId, content: answer, result: persistedResult }),
      });
      if (activeConversationRef.current === targetId) setActiveMessages(targetId, [...messagesRef.current, { ...response.message, result }]);
      void searchConversations(searchRef.current);
    } catch (cause) {
      setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "This facility result could not be saved to the chat.");
    }
  }, [searchConversations, setActiveMessages]);

  const removeMessage = useCallback(async (id: string) => {
    const targetId = activeConversationRef.current;
    if (!targetId) return;
    try {
      await requestApi<void>(`/api/rag/conversations/${encodeURIComponent(targetId)}/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
      setActiveMessages(targetId, messagesRef.current.filter((item) => item.id !== id));
    } catch (cause) { setPersistenceWarning(cause instanceof ApiFailure ? cause.message : "The unsent message could not be removed."); }
  }, [setActiveMessages]);

  const value = useMemo<ConversationContextValue>(() => ({
    messages, conversations, draft, setDraft, restored, listLoading,
    pendingMessageId: conversationId ? pendingByConversation[conversationId] ?? null : null,
    persistenceWarning, conversationId, searchConversations, createConversation, selectConversation,
    renameConversation, deleteConversation, sendMessage, appendAssistantResult, removeMessage,
  }), [messages, conversations, draft, restored, listLoading, pendingByConversation, conversationId, persistenceWarning,
    searchConversations, createConversation, selectConversation, renameConversation, deleteConversation, sendMessage, appendAssistantResult, removeMessage]);

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useAssistantConversation() {
  const value = useContext(ConversationContext);
  if (!value) throw new Error("AssistantConversationProvider is missing from the dashboard layout.");
  return value;
}


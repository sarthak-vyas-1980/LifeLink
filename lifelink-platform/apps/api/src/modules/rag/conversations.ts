import { randomUUID } from "node:crypto";
import { AssistantMessageRole, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { database } from "@lifelink/database";
import { ApiError } from "../../middleware/api-error";
import type { AuthContext } from "../../middleware/auth";
import { recordAuditEvent } from "../audit/service";
import { assessEmergency, createAssistantInteractionId, extractOperationalContext, generateAssistantResponse } from "./orchestrator";
import { buildEmergencyAnswer } from "./emergency";

const searchSchema = z.object({ q: z.string().trim().max(100).optional() }).strict();
const createSchema = z.object({ title: z.string().trim().min(1).max(120).optional() }).strict();
const renameSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
const messageSchema = z.object({
  clientMessageId: z.string().uuid(),
  message: z.string().trim().min(1).max(2000),
}).strict();
const eventSchema = z.object({
  clientMessageId: z.string().uuid(),
  content: z.string().trim().min(1).max(2000),
  result: z.object({
    answer: z.string().max(8000), intent: z.string().max(60),
    knowledgeUsed: z.boolean(), liveDataUsed: z.boolean(),
    sources: z.array(z.object({ sourceKey: z.string(), title: z.string(), similarity: z.number(), pageNumbers: z.array(z.number()).optional() }).strict()),
    limitations: z.array(z.string()),
    handoff: z.object({ label: z.string(), href: z.string(), reason: z.string() }).strict().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["ANSWERED", "NO_RESULTS", "NEEDS_INPUT", "UNAVAILABLE", "NOT_PERMITTED"]).optional(),
    suggestions: z.array(z.string().max(160)).max(4).optional(),
    display: z.enum(["conversation", "knowledge", "facilities", "inventory", "record", "emergency", "clarification", "unavailable"]).optional(),
  }).strict(),
}).strict();

export function assistantConversationOwnerWhere(actor: AuthContext) {
  if (actor.principalType === "USER" && actor.userId) return { ownerUserId: actor.userId, ownerInstitutionId: null };
  if (actor.principalType === "INSTITUTION" && actor.institutionId) return { ownerUserId: null, ownerInstitutionId: actor.institutionId };
  throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
}

function ownedConversationWhere(id: string, actor: AuthContext) {
  return { id, ...assistantConversationOwnerWhere(actor) };
}

function requireUuid(value: string | string[] | undefined) {
  if (typeof value !== "string" || !z.string().uuid().safeParse(value).success) throw new ApiError(400, "INVALID_CONVERSATION_ID", "The conversation identifier is invalid.");
  return value;
}

function titleFromMessage(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 58 ? `${normalized.slice(0, 57).trimEnd()}…` : normalized;
}

function messageDto(message: { id: string; clientMessageId: string; role: AssistantMessageRole; content: string; result: Prisma.JsonValue | null; createdAt: Date }) {
  return {
    id: message.role === AssistantMessageRole.USER ? message.clientMessageId : message.id,
    role: message.role === AssistantMessageRole.USER ? "user" as const : "assistant" as const,
    content: message.content,
    ...(message.result && typeof message.result === "object" ? { result: message.result } : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

function answerDto(message: { content: string; result: Prisma.JsonValue | null; id: string }) {
  return message.result && typeof message.result === "object"
    ? { ...(message.result as Record<string, unknown>), answer: message.content, messageId: message.id }
    : null;
}

async function auditAnswer(actor: AuthContext, result: Awaited<ReturnType<typeof generateAssistantResponse>>) {
  try {
    await recordAuditEvent({
      actorId: actor.userId,
      actorInstitutionId: actor.institutionId,
      action: "RAG_QUERY_ANSWERED",
      entityType: "RagInteraction",
      entityId: createAssistantInteractionId(),
      metadata: {
        intent: result.intent,
        knowledgeUsed: result.knowledgeUsed,
        liveDataUsed: result.liveDataUsed,
        sourceCount: result.sources.length,
        handoff: result.handoff?.href ?? null,
      },
    });
  } catch {
    console.error("LifeLink assistant interaction audit write failed");
  }
}

export async function listAssistantConversations(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const parsed = searchSchema.safeParse(request.query);
  if (!parsed.success) throw new ApiError(400, "INVALID_CONVERSATION_SEARCH", "Enter a search under 100 characters.");
  const q = parsed.data.q?.trim();
  const rows = await database.assistantConversation.findMany({
    where: {
      ...assistantConversationOwnerWhere(request.auth),
      ...(q ? { OR: [
        { title: { contains: q, mode: "insensitive" } },
        { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
      ] } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { _count: { select: { messages: true } }, messages: { take: 1, orderBy: { createdAt: "desc" }, select: { content: true } } },
  });
  response.json({ conversations: rows.map((row) => ({
    id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString(),
    messageCount: row._count.messages, preview: row.messages[0]?.content ?? "",
  })) });
}

export async function createAssistantConversation(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const parsed = createSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new ApiError(400, "INVALID_CONVERSATION", "Enter a chat name under 120 characters.");
  const owner = assistantConversationOwnerWhere(request.auth);
  const row = await database.assistantConversation.create({
    data: { ...owner, title: parsed.data.title ?? "New chat" },
  });
  response.status(201).json({ conversation: { id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString(), messageCount: 0, preview: "" } });
}

export async function getAssistantConversation(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const id = requireUuid(request.params.id);
  const row = await database.assistantConversation.findFirst({
    where: ownedConversationWhere(id, request.auth),
    include: { messages: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  if (!row) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  response.json({ conversation: { id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString(), messages: row.messages.map(messageDto) } });
}

export async function renameAssistantConversation(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const id = requireUuid(request.params.id);
  const parsed = renameSchema.safeParse(request.body);
  if (!parsed.success) throw new ApiError(400, "INVALID_CONVERSATION_TITLE", "Enter a chat name under 120 characters.");
  const updated = await database.assistantConversation.updateMany({
    where: ownedConversationWhere(id, request.auth), data: { title: parsed.data.title, updatedAt: new Date() },
  });
  if (!updated.count) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  const row = await database.assistantConversation.findFirst({ where: ownedConversationWhere(id, request.auth), select: { id: true, title: true, updatedAt: true } });
  if (!row) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  response.json({ conversation: { ...row, updatedAt: row.updatedAt.toISOString() } });
}

export async function deleteAssistantConversation(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const id = requireUuid(request.params.id);
  const deleted = await database.assistantConversation.deleteMany({ where: ownedConversationWhere(id, request.auth) });
  if (!deleted.count) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  response.status(204).end();
}

export async function sendAssistantConversationMessage(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const conversationId = requireUuid(request.params.id);
  const parsed = messageSchema.safeParse(request.body);
  if (!parsed.success) throw new ApiError(400, "INVALID_ASSISTANT_MESSAGE", "Enter a message under 2,000 characters with a valid message identifier.");
  try {
    await answerConversationMessage(request, response, conversationId, parsed.data);
  } catch (error) {
    // Emergency guidance must not depend on the database: if saving or loading the chat fails,
    // still return the deterministic emergency answer (unsaved) instead of an error.
    const emergency = error instanceof ApiError ? null : assessEmergency(parsed.data.message);
    if (!emergency || response.headersSent) throw error;
    console.error("LifeLink assistant storage failed during an emergency message", error instanceof Error ? error.name : "UnknownError");
    response.json({ result: { ...buildEmergencyAnswer(emergency), messageId: randomUUID(), answeredAt: new Date().toISOString(), persisted: false } });
  }
}

async function answerConversationMessage(request: Request, response: Response, conversationId: string, input: z.infer<typeof messageSchema>) {
  const parsed = { data: input };
  const conversation = await database.assistantConversation.findFirst({ where: ownedConversationWhere(conversationId, request.auth!), select: { id: true, title: true } });
  if (!conversation) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");

  const userKey = { conversationId_clientMessageId_role: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.USER } };
  const assistantKey = { conversationId_clientMessageId_role: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.ASSISTANT } };
  const existingUser = await database.assistantMessage.findUnique({ where: userKey });
  if (existingUser && existingUser.content !== parsed.data.message) throw new ApiError(409, "MESSAGE_ID_REUSED", "This message identifier was already used for different text.");

  const existingAssistant = await database.assistantMessage.findUnique({ where: assistantKey });
  if (existingAssistant) {
    response.json({ result: answerDto(existingAssistant) });
    return;
  }

  const userMessage = await database.assistantMessage.upsert({
    where: userKey,
    create: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.USER, content: parsed.data.message },
    update: {},
  });
  if (userMessage.content !== parsed.data.message) throw new ApiError(409, "MESSAGE_ID_REUSED", "This message identifier was already used for different text.");
  await database.assistantConversation.update({ where: { id: conversationId }, data: {
    updatedAt: new Date(), ...(conversation.title === "New chat" ? { title: titleFromMessage(parsed.data.message) } : {}),
  } });

  const previousMessages = await database.assistantMessage.findMany({
    where: { conversationId, NOT: { id: userMessage.id } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8,
    select: { role: true, content: true, result: true },
  });
  const recent = previousMessages.reverse().map((item) => ({ role: item.role === AssistantMessageRole.USER ? "user" as const : "assistant" as const, content: item.content, result: item.result }));
  let result;
  try {
    result = await generateAssistantResponse({
      message: userMessage.content,
      actor: request.auth!,
      // Text history and operational state (stored facility lists) are passed separately.
      history: recent.map(({ role, content }) => ({ role, content })),
      operational: extractOperationalContext(recent),
    });
  } catch (error) {
    console.error("LifeLink assistant request failed", error instanceof Error ? error.name : "UnknownError");
    throw new ApiError(503, "ASSISTANT_UNAVAILABLE", "The LifeLink assistant is temporarily unavailable. Your message was saved; retry it shortly.");
  }

  const storedResult = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  const assistantMessage = await database.assistantMessage.upsert({
    where: assistantKey,
    create: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.ASSISTANT, content: result.answer, result: storedResult },
    update: {},
  });
  await database.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  await auditAnswer(request.auth!, result);
  response.json({ result: { ...result, messageId: assistantMessage.id, answeredAt: assistantMessage.createdAt.toISOString() } });
}

export async function appendAssistantConversationEvent(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const conversationId = requireUuid(request.params.id);
  const parsed = eventSchema.safeParse(request.body);
  if (!parsed.success) throw new ApiError(400, "INVALID_ASSISTANT_EVENT", "This assistant result could not be saved.");
  const conversation = await database.assistantConversation.findFirst({ where: ownedConversationWhere(conversationId, request.auth), select: { id: true } });
  if (!conversation) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  const key = { conversationId_clientMessageId_role: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.ASSISTANT } };
  const row = await database.assistantMessage.upsert({
    where: key,
    create: { conversationId, clientMessageId: parsed.data.clientMessageId, role: AssistantMessageRole.ASSISTANT, content: parsed.data.content, result: parsed.data.result as Prisma.InputJsonValue },
    update: {},
  });
  await database.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  response.status(201).json({ message: messageDto(row) });
}

export async function deleteUnansweredAssistantUserMessage(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const conversationId = requireUuid(request.params.id);
  const clientMessageId = requireUuid(request.params.messageId);
  const conversation = await database.assistantConversation.findFirst({ where: ownedConversationWhere(conversationId, request.auth), select: { id: true } });
  if (!conversation) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "This conversation is unavailable.");
  const userKey = { conversationId_clientMessageId_role: { conversationId, clientMessageId, role: AssistantMessageRole.USER } };
  const assistantKey = { conversationId_clientMessageId_role: { conversationId, clientMessageId, role: AssistantMessageRole.ASSISTANT } };
  const [userMessage, answer] = await Promise.all([
    database.assistantMessage.findUnique({ where: userKey, select: { id: true } }),
    database.assistantMessage.findUnique({ where: assistantKey, select: { id: true } }),
  ]);
  if (!userMessage) throw new ApiError(404, "MESSAGE_NOT_FOUND", "This unsent message is unavailable.");
  if (answer) throw new ApiError(409, "MESSAGE_ALREADY_ANSWERED", "An answered message cannot be removed here.");
  await database.assistantMessage.delete({ where: { id: userMessage.id } });
  await database.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  response.status(204).end();
}

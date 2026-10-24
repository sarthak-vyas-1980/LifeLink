# Persistent Assistant Conversations

## Storage and retention

`AssistantConversation` and `AssistantMessage` live in the operational PostgreSQL database managed by Prisma. A conversation has exactly one owner: an authenticated user or institution. The database migration enforces that invariant and cascades conversation/message deletion when its owner account is deleted. Conversations are retained until their owner deletes them or the owning account is deleted; there is no automatic expiry.

Messages are separate rows. A unique `(conversationId, clientMessageId, role)` key makes retried sends idempotent. The user's message is saved before answer generation so a failed response can be retried after navigation or a browser restart. Structured assistant results are stored as JSON with the assistant message, preserving citations and inline facility map data.

## Ownership

Every list, read, rename, delete, message send, event append, and unsent-message removal filters by the owner derived from the verified request auth context. User sessions are scoped to `ownerUserId`; institution sessions are scoped to `ownerInstitutionId`. Request status and other private LifeLink lookups continue to enforce their own record-level authorization. The model never supplies owner identifiers.

## API and context

- `GET/POST /api/rag/conversations` lists/searches and creates chats.
- `GET/PATCH/DELETE /api/rag/conversations/:id` reads, renames, and deletes an owned chat.
- `POST /api/rag/conversations/:id/messages` stores a user turn, derives context only from that conversation's stored message rows, and saves the assistant result.
- `POST /api/rag/conversations/:id/events` saves an authenticated facility-search result to that chat.
- `DELETE /api/rag/conversations/:id/messages/:messageId` removes only an unanswered user turn for retry editing.

The browser stores only the last active conversation identifier for convenience. It stores no message text or medical details. On startup, the app fetches the selected conversation and owner-scoped chat list from the server. New chats have no prior messages and therefore cannot inherit another conversation's context.

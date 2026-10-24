# LifeLink RAG Workflow

## Scope

The conversational assistant handles general-purpose discussion and answers factual LifeLink or healthcare questions using the approved RAG and live application services. The blood-request and organ-coordination workflows remain in their existing modules. The assistant may explain them or provide a safe link to them, but it does not reimplement their state transitions.

## Offline knowledge indexing

1. A reviewer approves a source and adds it to the code-owned allow-list in `packages/rag/src/knowledge-sources.ts`.
2. The indexing script loads only the approved Markdown sources, normalizes text, splits it into bounded overlapping chunks, and computes a SHA-256 checksum.
3. Gemini Embedding 2 creates 768-dimensional embeddings for the chunks.
4. Source metadata and vectors are stored in the separate Supabase pgvector store. The operational Aiven PostgreSQL database is not used as the vector store.
5. Re-indexing skips unchanged sources, updates changed chunks, removes surplus chunks, and records source status. Only sources marked `INDEXED` participate in retrieval.

## Online query handling

1. The authenticated API receives the query and a short conversation history.
2. A deterministic emergency severity check inspects the current message and only relevant referential follow-ups from recent user turns before Gemini, retrieval, or other tools run. Critical indicators such as major blood loss, uncontrolled bleeding, loss of consciousness, severe breathing problems, serious trauma, stroke signs, and severe burns return a fixed emergency response with India’s 112 call action data. A new emergency overrides earlier minor-injury context; unrelated new messages do not inherit old emergency state. The configured Gemini generation model then classifies ordinary messages into a validated route. Urgent blood/organ requests, explicit clinical/safety questions, first-person injuries, urgent inability to bear weight/severe swelling, and explicit state-changing actions also take deterministic routes.
3. Live operational questions use read-only queries to the existing Aiven/Prisma application data, subject to role and record-level access checks. An explicit user-provided locality may be geocoded for proximity ranking. For relevant care-discovery requests, the browser checks existing geolocation permission and, when already granted, obtains one fresh position for that search; otherwise the user can choose the location action or provide a locality. Precise device coordinates are not persisted in conversation history.
4. Explanatory questions are embedded and searched against only sources visible to the authenticated role. Relevant approved passages are supplied to Gemini 3.1 Flash-Lite.
5. The response includes sources/limitations when relevant. If evidence is insufficient, the assistant says so rather than guessing.
6. Any state-changing request is handed back to an existing authenticated workflow; the assistant does not write operational state.

General questions (including writing, coding, and technical topics) and greetings do not trigger healthcare RAG or operational tools. Gemini answers general questions using its model knowledge and does not claim web browsing. Routine first aid uses conservative instructions and retrieved medical passages when available, with pharmacy/clinic/emergency-care boundaries. Critical emergencies use deterministic instructions and never wait for Gemini. The frontend's fixed `tel:112` link is user-activated; the app does not place calls or transmit location automatically and cannot verify a call connected. No external web-search provider is configured, so current claims that require browsing are not represented as verified.

## Separate sources of truth

- **Approved documentation and policies:** RAG vector store.
- **Current inventory, facilities, request status, offers, donor/recipient records:** authorized operational backend and PostgreSQL.
- **Actions such as create, cancel, accept, reject, consent verification, and procurement transitions:** existing authenticated workflow endpoints.

The RAG store must never be treated as current inventory or workflow state. Do not index medical reports, donor/recipient personal records, credentials, or raw live inventory exports as general FAQ content.

## Safety limits

The assistant does not diagnose, prescribe, determine donor eligibility, make final transfusion-compatibility decisions, or decide organ allocation. Live facility/inventory results are not guarantees. The current application does not provide a scheduled blood-donation-camp calendar, so upcoming camps cannot be confirmed. Current handover notes also state that dedicated organ transport records/routes were removed; the assistant must not promise a transport workflow until the discrepancy with older SRS wording is resolved.

# LifeLink RAG Setup and Operations

## Boundary

The RAG knowledge store is hosted separately from the Aiven operational PostgreSQL database. The operational database remains authoritative for inventory, request status, donor/recipient records, offers, and facilities. Supabase is used for the vector tables in this initial implementation; the existing private medical-report storage bucket is not used as a general knowledge corpus.

The current RAG allow-list indexes only the reviewed Markdown sources under `docs/knowledge/` and selected internal workflow/SRS documentation. Roles are attached to each source and enforced in vector search. Do not add medical reports, donor/recipient documents, live inventory exports, credentials, or unreviewed uploads to the general FAQ corpus.

## One-time Supabase setup

1. Open the Supabase project dashboard.
2. Open SQL Editor.
3. Run `infra/database/rag-vectors.sql` from this repository.
4. Keep the Aiven `DATABASE_URL` as the operational database connection. Do not use it as the vector-store URL.
5. Create or retain a server-side `.env` in the `lifelink-platform` root. Copy variable names from `.env.example`, and populate `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `GEMINI_API_KEY` locally. Never commit `.env`; never use `NEXT_PUBLIC_` for the secret key.

The RAG schema uses 768-dimensional `gemini-embedding-2` vectors. If you change embedding dimensions, alter the pgvector columns/function and rebuild every existing embedding before changing `RAG_EMBEDDING_DIMENSIONS`.

## Index approved documents

From `lifelink-platform`:

```bash
npm run rag:index
```

To process one approved source:

```bash
npm run rag:index -- blood-request-guide
```

Only keys present in `packages/rag/src/knowledge-sources.ts` are accepted. Re-indexing is checksum-aware: unchanged indexed sources are skipped. Source changes cause embeddings to be regenerated and old surplus chunks to be removed.

## Runtime endpoints

All endpoints require an authenticated LifeLink session.

- `POST /api/rag/query`: accepts `{ "message": "...", "history": [] }`.
- `GET /api/rag/sources`: lists indexed sources visible to the current role.
- `POST /api/rag/reindex`: administrator-only maintenance endpoint; accepts an optional approved `sourceKey`.

The configured Gemini generation model first classifies the message into a validated intent using the recent conversation context. Approved documentation is retrieved for relevant factual questions; current inventory, facility discovery, and request-status intents use the existing read-only operational queries; state-changing actions are handed back to existing workflows. Greetings and out-of-scope prompts skip retrieval and receive a short scope-aware response. The assistant does not mutate request or inventory records.

There is currently no external web-search provider configured. When the approved knowledge index lacks evidence, the assistant says so rather than claiming to browse or fabricating external citations. Adding an external provider would require selecting and configuring an approved source service and implementing source URL attribution; it is not part of the current deployment.

## Security and data freshness

- The Supabase secret key is used only by the API server. It must never be sent to a browser.
- Do not send raw chat messages, passwords, medical details, or tokens to audit logs. The RAG API logs the interaction category and source count, not the full message.
- Live inventory results include their last-updated timestamp. Records older than 24 hours are flagged for confirmation. Facility discovery uses active institution records with usable coordinates; records lacking coordinates cannot be asserted as nearby.
- The current schema has no scheduled blood-donation-camp calendar. The assistant may show registered blood-service facilities but must explicitly say it cannot confirm upcoming camp dates.
- Current implementation notes remove organ transport records/routes even though older SRS language mentions transport. The RAG allow-list therefore includes a warning in the administrator guide and must not promise an organ-transport workflow.
- A RAG answer is not proof of an operational change and cannot be used for clinical, transfusion, donor-eligibility, or final organ-allocation decisions.

## Validation

Run:

```bash
npm run typecheck
npm test
```

The RAG tests cover intent routing, document chunking, and explicit location extraction. Integration verification of Gemini and Supabase requires the environment variables above and a configured Supabase vector schema.

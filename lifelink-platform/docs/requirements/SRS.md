# LifeLink SRS Reference — RAG Scope Summary

This is a concise implementation reference for the approved LifeLink Software Requirements Specification (SRS), Version 2.0 (dated 1 October 2026). It is not a replacement for the full submitted SRS.

## Product scope relevant to the assistant

The Smart FAQ Assistant provides natural-language assistance using approved LifeLink documentation, FAQs, standard operating procedures, and policies. It explains platform usage and workflows; it is not a separate blood or organ workflow engine.

## RAG functional requirements

The SRS Section 4.9 defines these requirements:

- LL-FR-RAG-001: provide a natural-language interface.
- LL-FR-RAG-002: process queries and identify relevant information needs.
- LL-FR-RAG-003: generate embeddings for supported knowledge content.
- LL-FR-RAG-004: retrieve relevant information from approved knowledge sources.
- LL-FR-RAG-005: use retrieved context for applicable responses.
- LL-FR-RAG-006: use the configured language model for response generation.
- LL-FR-RAG-007: distinguish knowledge-based information from live operational information.
- LL-FR-RAG-008: obtain live information through authorized application/backend services rather than the vector store.
- LL-FR-RAG-009: enforce authorization for protected operational context.
- LL-FR-RAG-010: handle insufficient retrieval evidence appropriately.
- LL-FR-RAG-011: do not present answers as authoritative medical or regulatory decisions.
- LL-FR-RAG-012: do not allow the LLM to autonomously modify protected operational records.
- LL-FR-RAG-013: support maintenance and updating of approved knowledge sources.
- LL-FR-RAG-014: maintain appropriate records of significant AI-assisted interactions where required.

## Architecture and constraints

- PostgreSQL through Prisma remains the operational source of truth for institutions, inventory, requests, offers, and coordination records.
- The RAG vector store must remain separate from the operational database.
- The synopsis specifies Gemini Embedding 2 and Gemini 3.1 Flash-Lite. The exact vector-database technology was TBD in the SRS; this project implementation uses Supabase pgvector as its configured RAG store.
- The assistant must respect role-based access, protect personal and medical information, and distinguish a candidate match from confirmed fulfilment.
- LifeLink does not replace qualified clinical judgment or official organ-allocation processes.
- The current handover says organ transport records/routes were removed, despite older SRS wording about transport. The assistant must not claim the dedicated transport workflow exists until the project documentation is reconciled.

## Evaluation and maintenance

The SRS requires approved-source maintenance, graceful handling of missing or stale information, and testing with synthetic or anonymised data. Knowledge updates must not alter unrelated operational records.

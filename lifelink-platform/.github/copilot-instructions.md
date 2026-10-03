# LifeLink Collaboration Rules

- Read `HANDOVER.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, and the relevant `FLOW.md` before changing code.
- Make one logical change per request and inspect the actual diff.
- Keep PostgreSQL authoritative for live operational state.
- Keep RAG knowledge and predictive outputs separate from operational truth.
- Enforce authorization in backend services, not only in the client.
- Record significant workflow, security, and administrative changes for audit.
- Do not make autonomous clinical, transfusion, or organ-allocation decisions.
- Run the focused validation for the touched file before widening the change.

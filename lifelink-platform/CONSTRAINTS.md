# Constraints

- Backend authorization is authoritative.
- PostgreSQL is the source of truth for live operational data.
- RAG and prediction remain decision support only.
- Do not make autonomous clinical, transfusion, or organ-allocation decisions.
- Keep hospital, blood-centre, and organ-centre entities separate.
- Do not expose sensitive donor, recipient, document, or audit data outside scope.

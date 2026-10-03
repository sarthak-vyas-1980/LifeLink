# Architecture

## Layers

- Actors and role-based web interface
- API and authorization boundary
- Operational services and workflow state machines
- RAG and predictive decision-support services
- PostgreSQL, Redis, vector store, and object storage
- Docker deployment and external service adapters

## Source Of Truth

PostgreSQL owns live operational state. RAG knowledge and predictive outputs must remain separate decision-support data.

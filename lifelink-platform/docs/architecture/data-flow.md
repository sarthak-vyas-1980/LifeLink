# Data Flow

## Primary Paths

- User request -> API validation/RBAC -> PostgreSQL workflow state
- Matching -> offer/review -> reservation or retry search
- State transition -> audit -> Socket.IO/Redis -> authorized clients
- RAG query -> retrieval/live context -> grounded response
- Historical data -> analytics -> forecast/risk result for planning

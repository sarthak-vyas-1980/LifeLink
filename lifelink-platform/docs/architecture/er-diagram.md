# ER Diagram Reference

## Entity Groups

- Identity: User, Administrator, and separate Institution accounts
- Institutions: Institution and facility-specific profiles
- Resources: Blood Inventory, Organ Inventory, Donation Inventory
- Coordination: Request, Request Recipient, Match, Donation, Allocation
- Supporting records: Notification, User Document, RAG Knowledge Base, Audit Log

## Relationship Rule

Operational relationships must be represented with explicit foreign keys and authorization-aware repositories.

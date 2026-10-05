# Handover

## Current State

- Completed: Added an organ-coordination vertical slice using separate Prisma records for donors, consent, organ inventory, recipient requirements, potential matches, offers, procurement, preservation policy, and workflow events. Added scoped Express endpoints and state transitions, transactional audit/outbox updates, deduplicated offer/preservation alert workers, operational timing calculations, and organ-centre dashboard and workflow pages.
- Completed: Applied migration `20261005140000_organ_coordination` to the configured PostgreSQL database. The current schema has later prepared migrations; apply them after handling the documented legacy data requirements. Prisma Client was generated.
- Completed: Preserved existing blood request routes and added unit coverage for organ transition validation and configurable preservation timing.
- In progress: The organ UI covers listing, creating, review/offer response, procurement, and status actions. It still needs richer inventory filters/pagination, document-storage integration, and broader database-backed authorization/workflow integration tests.
- In progress: Synthetic demo seed script exists and is guarded by `LIFELINK_ALLOW_DEMO_SEED=YES`; it has not been run against the configured database.
- In progress: Earlier auth changes are still part of the working tree: account-kind selection, phone validation, and institution role verification.
- In progress: User and institution accounts have separate identities. Users have USER or ADMIN roles; institutions authenticate through InstitutionAccount and are typed as HOSPITAL, BLOOD_BANK, or ORGAN_CENTRE. USER accounts may use both donation discovery and recipient request workflows. Hospital blood and organ services are optional independent capabilities. Migration `20261005160000_account_and_institution_roles` is prepared but has not been applied.
- In progress: Organ transport records, API routes, and dashboard pages were removed. Migration `20261006180000_remove_organ_transport_require_user_phone` drops the already applied transport table and makes `User.phone` required; populate any existing null user phones before applying it.
- Blocked: None.

## Next Session

- First file or function to inspect: `apps/api/src/modules/organ-coordination/service.ts`, then `apps/web/components/organ/index.tsx`.
- Verification command: `npm run typecheck`, `npm test`, and `npm --workspace @lifelink/web run build`.
- Risks or constraints: Organ candidate ranking is operational coordination only. Preservation policy values are configurable demo thresholds and do not determine clinical viability. Keep donor/recipient data institution-scoped. Avoid touching the existing blood workflow while extending organ behavior.

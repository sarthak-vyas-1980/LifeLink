# Organ Coordination Flow

## Workflow

Recipient requirement -> configured matching -> potential matches -> offer -> evaluation -> procurement -> fulfilled.

## Boundary

The platform coordinates and records workflow states; it does not autonomously determine final medical eligibility or organ allocation.

## Implemented data model

Organ coordination has dedicated relational records in Prisma: `OrganDonor`, `OrganConsent`, `OrganRecord`, `OrganRecipient`, `RecipientRequirement`, `OrganMatch`, `OrganOffer`, `OrganProcurement`, `OrganPreservationPolicy`, and `OrganWorkflowEvent`. The blood `Match`, `OrganInventory`, and reservation workflow remain separate and unchanged. References shown to users are generated coordination references; donor and recipient user details are not included in inventory lists.

`OrganRecord.status` is changed through a transition map in the organ coordination service. An offer can be created only from a reviewed shortlist. An acceptance/rejection checks the receiving centre and offer deadline in a transaction. Procurement uses checked state transitions. PostgreSQL holds current status, the per-organ timeline, generic audit rows, notifications, and workflow outbox events. Realtime delivery uses the existing authenticated per-user Socket.IO rooms.

## Candidate ranking

The matcher filters on organ type and any configured blood-group filter, then applies optional geographic radius and a recipient requirement maximum distance. It ranks candidates using configured requirement priority and distance. The criteria snapshot and human-readable reasons are persisted on each `OrganMatch`. The output is named **Potential Coordination Matches**; it is not a clinical compatibility or allocation decision. A user with organ-centre scope must review and shortlist a generated candidate before an offer can be sent.

## Preservation timing

`OrganPreservationPolicy` stores per-organ-type/method target, warning, critical, and maximum hours. Admins configure these values using `PUT /api/organs/preservation-policies`. The seeded demo policy label is `DEMO / CONFIGURABLE - NOT A CLINICAL RULE`. The API and web client calculate elapsed and remaining time from `preservationStartTime`; no recurring timer-value writes occur. A one-minute worker creates deduplicated warning, critical, and expired alert events and notifications when configured thresholds are crossed. The UI calls this a preservation timer and states that clinical suitability belongs to authorized professionals.

## API and roles

All routes below require a bearer token. Organ-centre users are limited to their active organ-centre institution; administrators may oversee all centres. Receiving organ-centre users can respond only to offers addressed to their institution. Cross-institution reads return not found to avoid exposing whether a record exists.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`, `POST` | `/api/organs` | List scoped records; register an organ after verified donor authorization |
| `GET` | `/api/organs/:organId` | Read a scoped detail and event timeline |
| `PATCH` | `/api/organs/:organId/status` | Request a legal organ state transition |
| `GET`, `POST` | `/api/organs/donors` | List references or create a consent-recorded donor |
| `POST` | `/api/organs/donors/:donorId/consent/verify` | Verify recorded consent and authorization |
| `GET`, `POST` | `/api/organs/recipients` | List or create a recipient requirement |
| `POST`, `GET` | `/api/organs/:organId/matches` | Generate or view potential coordination matches |
| `PATCH` | `/api/organs/matches/:matchId/review` | Review, shortlist, or reject a candidate |
| `GET`, `POST` | `/api/organs/offers` | List or create/send a shortlisted match offer |
| `POST` | `/api/organs/offers/:offerId/respond` | Accept or reject an offer at the receiving centre |
| `GET`, `POST` | `/api/organs/procurements` | List or schedule procurement |
| `PATCH` | `/api/organs/procurements/:id/status` | Advance procurement status |
| `POST`, `GET` | `/api/organs/:organId/preservation/start`, `/api/organs/:organId/preservation` | Start and read configured operational timing |
| `GET` | `/api/organs/:organId/audit` | Read scoped organ workflow events |

Inputs are Zod-validated. Important state updates and their organ timeline/audit/outbox rows are grouped in Prisma transactions. Notifications contain references and operational states, not donor medical data.

## Migration and demo data

The original organ-coordination migration is `packages/database/prisma/migrations/20261005140000_organ_coordination`. The follow-up schema migration `packages/database/prisma/migrations/20261006180000_remove_organ_transport_require_user_phone` removes the organ transport model and makes user phone numbers required. Populate phone numbers for existing users before applying that migration. Prisma schema validation and client generation succeed.

To create synthetic demonstration records after the migration is applied, set `LIFELINK_ALLOW_DEMO_SEED=YES` and run `npm run seed:organ-demo`. The seed is idempotent for its fixed references and creates no real donor or recipient information. It includes normal, warning, critical, and expired timer examples, plus a potential match and pending offer.

## Verification

`npm run typecheck` covers all workspaces. `npm test` includes pure unit checks for legal organ transitions and threshold-based preservation timing alongside the existing blood/security suites. Database-backed organ integration scenarios still require a dedicated disposable test database and seeded organ-centre fixture.

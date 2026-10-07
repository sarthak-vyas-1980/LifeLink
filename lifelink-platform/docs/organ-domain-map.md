# LifeLink organ domain map

| Responsibility | Backend owner | Frontend entry |
| --- | --- | --- |
| Personal donor requests | `modules/organ-coordination/personal.service.ts` and `modules/donations/organ-donors.service.ts` | `/organ-services` Donate view |
| Recipient requirements | `modules/organ-coordination/personal.service.ts` and `modules/organ-coordination/recipients.service.ts` | `/organ-services` Receive view |
| Consent request and user response | `modules/consent/service.ts`, mounted at `/api/organ-consents` | `/organ-services` activity and consent actions |
| Organ lifecycle and state validation | `modules/organ-coordination/shared.ts` and `modules/inventories/organ.service.ts` | `/organ-centre/organs` |
| Inventory and preservation | `modules/inventories/organ.service.ts` and `modules/inventories/organ-preservation.service.ts` | `/organ-centre/organs`, `/inventory` |
| Candidate matching | `modules/matches/organ.service.ts` | `/organ-centre/matching` |
| Offers | `modules/organ-coordination/offers.service.ts` | `/organ-centre/offers` |
| Procurement | `modules/organ-coordination/procurement.service.ts` | `/organ-centre/procurement` |
| Institution access and discovery | `modules/institutions/routes.ts` | `/institution`, `/organ-centre` |
| Administrator analytics and institution status | `modules/admin/routes.ts` | `/admin` |
| Audit and notifications | `modules/audit/organ.service.ts`, `modules/notifications/organ.service.ts` | `/organ-centre/audit`, `/notifications` |

Organ lifecycle changes are validated by the backend and written with workflow and audit events. Personal donation rows are per organ; a partial PostgreSQL unique index permits history while preventing two active requests for the same user and organ. Consent stays a separate module: an institution can request it, only the account holder can accept or decline, and an institution can verify only an accepted response. Retrieval state changes run through procurement. The organ lifecycle has no transport, transit, or delivery states.

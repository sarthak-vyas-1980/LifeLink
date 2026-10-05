# LifeLink API

The API is served from `API_BASE_URL` (default local port `4000`). Protected endpoints accept `Authorization: Bearer <token>`. Error responses use `{ code, message, traceId?, fieldErrors? }`; unexpected errors never include exception text or stack traces.

## Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create a user account with role `USER` or `ADMIN`, or create a separate institution account with `institutionType`, `address`, `name`, `email`, `phone`, and `password`. Passwords must contain at least six characters. Hospital registration may enable blood and organ services independently. |
| `POST` | `/api/auth/login` | Authenticate with `{ "email", "phone", "password", "accountType": "USER" | "INSTITUTION" }`. Institution accounts are resolved from `InstitutionAccount`; their access comes from the institution type and enabled hospital services. |
| `POST` | `/api/auth/logout` | Revoke the presented bearer session. |

User accounts are not classified as donors or recipients. After authentication, users can choose donation discovery or blood request workflows; both are authorized under the USER access scope. Phone numbers are matched against the registered contact number; this is not phone-based one-time-password verification.

## Blood requests

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/requests/blood?limit=50` | List blood requests visible to the caller, scoped to requester, recipient, or institution participation. |
| `POST` | `/api/requests/blood` | Create a normal or urgent blood request; initial state is `CREATED`. |
| `GET` | `/api/requests/blood/:requestId` | Read a request if the caller is its requester, linked recipient, matched provider, or administrator. |
| `GET` | `/api/requests/blood/:requestId/offers` | Read safe offer and reservation details for an authorized participant. |
| `POST` | `/api/requests/blood/:requestId/review` | Administrator moves a new request into review. |
| `POST` | `/api/requests/blood/:requestId/match` | Requester starts or retries matching. Optional body `{ "radiusKm": 100 }` widens this search only. Results are candidates, not fulfilment guarantees. |
| `POST` | `/api/requests/blood/:requestId/offers/:matchId/respond` | Matched provider accepts or rejects its offer. Body: `{ "action": "ACCEPT" | "REJECT" }`. |
| `POST` | `/api/requests/blood/:requestId/offers/:matchId/evaluate` | Requester accepts or rejects a provider offer. |
| `POST` | `/api/requests/blood/:requestId/reopen` | Reopen an eligible request and release its active reservation. |
| `POST` | `/api/requests/blood/:requestId/cancel` | Cancel an eligible request. |
| `POST` | `/api/requests/blood/:requestId/dispatch` | Selected provider marks reserved units in transit. |
| `POST` | `/api/requests/blood/:requestId/receipt` | Requester confirms receipt and fulfilment. |

Request bodies are validated before service calls. Request responses are whitelist DTOs; contact details are returned only to the requester or an administrator. Patient medical details and persistence relations are not part of these response DTOs.

## Emergency blood requests

`POST /api/emergency/blood-requests` accepts the normal blood request fields except `priority`. The server sets `EMERGENCY`, places it into review, then runs the normal matcher immediately. `POST /api/emergency/blood-requests/:requestId/broadcast` retries matching for an authorized emergency requester. Emergency matches remain candidates; the route does not promise availability or replace clinical judgement.

## Institution discovery

`GET /api/institutions` returns active institutions with public map fields only. Optional filters: `type`, paired `latitude`/`longitude`, and `radiusKm` (requires coordinates).

## Inventory and notifications

- `POST /api/inventory/blood` creates inventory; `PATCH /api/inventory/blood/:inventoryId` updates the actor's institution inventory. `GET /api/inventory/blood/search` accepts blood group, component, quantity, and optional coordinates/radius.
- `GET /api/notifications` lists the authenticated user's inbox; `?unread=true&limit=50` filters it.
- `GET /api/notifications/sync?afterCreatedAt=<ISO>&afterId=<notification UUID>` replays that user's persisted notifications in stable cursor order.
- `POST /api/notifications/:notificationId/read` marks only the authenticated user's notification as read.
- Socket.IO authenticates with `{ auth: { token } }`, delivers `workflow:event` only to the recipient's user room, and accepts `workflow:sync` to replay from PostgreSQL.

## Organ coordination

The organ module is mounted at `/api/organs`. Its routes, methods, role scopes, state transitions, candidate ranking boundaries, and preservation timer behavior are documented in [Organ Coordination Flow](architecture/organ-coordination-flow.md). Organ records use separate tables from blood inventory and matching. All match results are potential coordination candidates; final medical assessment and allocation remain with authorized professionals.

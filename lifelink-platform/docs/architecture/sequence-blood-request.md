# Blood Request Sequence

## Participants

Requester, Web App, API, PostgreSQL, matching service, Redis/Socket.IO, and eligible institution or donor.

## Sequence

Create and validate -> persist review state -> search inventory -> present candidates -> accept and reserve -> dispatch -> receive -> fulfil and audit.

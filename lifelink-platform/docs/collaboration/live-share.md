# LifeLink Team Collaboration With Live Share

## Team Size

Use one host and two guests for a three-person session:

- Host: opens the LifeLink workspace and starts the session.
- Guest 1: works on the web application or shared UI components.
- Guest 2: works on the API, database, RAG, or analytics boundaries.

Assign one person as the session coordinator so shared workflow decisions are not made in parallel without discussion.

## Host Setup

1. Open `lifelink-platform` in VS Code.
2. Sign in to VS Code with a GitHub or Microsoft account.
3. Open the Live Share view or Command Palette.
4. Run `Live Share: Start collaboration session (Share)`.
5. Choose the least access required. Prefer read-only access for observers and collaboration access only for active contributors.
6. Copy the invitation link and send it privately to the two teammates.
7. Keep the link private and stop the session when the group is finished.

## Guest Setup

1. Install the Microsoft Live Share extension.
2. Sign in to VS Code with a GitHub or Microsoft account.
3. Open the invitation link.
4. Allow the browser to launch VS Code.
5. Join the shared workspace and verify the correct project folder before editing.

## Before Coding

1. Pull the latest Git changes before the host starts Live Share.
2. Read `HANDOVER.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, and the relevant `FLOW.md`.
3. Agree on one logical task per person.
4. Assign file ownership for the session to reduce simultaneous edits to the same file.
5. Keep the host responsible for final integration and verification.

## Suggested Three-Person Split

- Person 1: `apps/web` pages and components.
- Person 2: `apps/api` routes, middleware, and workflow services.
- Person 3: `packages/database`, `packages/rag`, and `services/analytics`.

Coordinate before changing shared contracts, Prisma schema, workflow status, or package manifests.

## Terminal and Debugging Safety

- Do not share terminals unless every participant understands the command and its effect.
- Do not expose `.env`, API keys, passwords, tokens, or private documents through the session.
- Prefer running commands from the host for a consistent environment.
- Verify destructive commands before running them.
- Stop the session before rotating credentials or handling sensitive production data.

## End of Session

1. Each person summarizes changed files and remaining work in `HANDOVER.md`.
2. Review the actual Git diff together.
3. Run focused checks for each changed area.
4. Stop the Live Share session.
5. Commit and push changes through the agreed Git workflow.

Live Share provides synchronized editing; Git remains the source of truth for history, review, and recovery.

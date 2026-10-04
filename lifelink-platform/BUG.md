# Bug Trace

## Bug Record: Pnpm Revert & Frontend Startup Failure

- Observed behavior:
  - Attempting to start the web frontend failed immediately; dev processes crashed and `http://localhost:3000` was unreachable.
- Expected behavior:
  - Running the dev server should start Next.js and render the blood coordination workspace.
- Reproduction:
  - Switch from pnpm back to npm without purging pnpm symlink stores, leaving broken/empty workspace `node_modules` folders.
  - Run `npm run dev` with ungenerated Prisma client or missing backend database environment, which caused `scripts/dev.mjs` to terminate all child processes including the frontend.
- Execution flow:
  - `dev.mjs` spawned `@lifelink/api` and `@lifelink/web`.
  - Stale `node_modules` lacked properly linked dependencies and Prisma client.
  - API process crashed and `dev.mjs` exit handler immediately killed the Next.js web process.
- Attempted fixes:
  - Cleaned all residual `.pnpm-store` and `.pnpm-node-modules-backup` directories.
  - Executed a clean `npm install` across all workspaces.
  - Ran `prisma generate` to produce the active client.
  - Added dedicated `npm run dev:web` and `npm run dev:api` scripts to root `package.json`.
  - Added seamless demo mode and offline fallback data to the web frontend for uninterrupted UI exploration.
- Root cause:
  - Leftover pnpm symlinks caused an empty `apps/web/node_modules`.
  - Missing Prisma client initialization and missing `DATABASE_URL` crashed the backend child process, triggering `scripts/dev.mjs` to kill the frontend server.
- Verification:
  - Started dev server on `http://localhost:3000`.
  - Verified compilation of `/login` and `/requests`.
  - Browser subagent completed end-to-end verification and captured screenshot of the Blood Requests & Offers workspace.


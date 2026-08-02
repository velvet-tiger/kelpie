# Kelpie

Open-source, agent-native CRM and company brain. Product direction and specs live in the docs repo alongside this one: `brief.md`, `roadmap.md`, `architecture.md`, `api.md`, `schema.md`, `modules.md`.

This repository is the production service. The clickable prototype stays in `mockups/` in the docs repo until its pages are ported.

## Requirements

- Node 24 or newer. The server runs TypeScript directly through Node's type stripping, so there is no build step for it.
- Docker, for the local Postgres.

## Setup

Run these in order from the repository root.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create your environment file.

   ```bash
   cp .env.example .env
   ```

3. Start Postgres and wait for it to report healthy.

   ```bash
   npm run db:up && docker compose ps
   ```

   The `db` row should read `Up (healthy)`.

4. Start the API and the UI together.

   ```bash
   npm run dev
   ```

   The API listens on the `PORT` from `.env` (3000 by default). The UI runs on http://localhost:5173 and proxies `/v1` and `/healthz` to the API, so the browser only ever talks to one origin.

5. Confirm the whole chain.

   ```bash
   curl -s http://localhost:5173/healthz
   ```

   Expected: `{"status":"ok","database":"up"}`. A `503` with `{"status":"degraded","database":"down"}` means the API is up but Postgres is not; go back to step 3.

Open http://localhost:5173 and the page reports the same status.

## Layout

```
packages/server/   @kelpie/server — the service as a library. Exports the Hono app,
                   config loader, database client, errors, ids, and logger.
packages/ui/       @kelpie/ui — React components and the typed API client.
apps/kelpie/       The open-source assembly. Boots the server, builds the UI.
```

`@kelpie/server` never starts a listener on import. `apps/kelpie` is the executable. The cloud repo assembles the same packages with private modules, per `modules.md`.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | API with file watching plus the Vite dev server |
| `npm run build` | Production build of the web bundle |
| `npm run lint` | oxlint across the repository. Silent means clean |
| `npm run typecheck` | `tsc` over every workspace |
| `npm test` | Vitest unit tests |
| `npm run db:up` / `npm run db:down` | Local Postgres container |

## Configuration

Every variable is required. There are no silent defaults; a missing or malformed value stops boot and prints the full list of problems.

| Variable | Values |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production` |
| `PORT` | API listen port |
| `DATABASE_URL` | `postgres://` or `postgresql://` connection string |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

`packages/server/src/lib/config.ts` is the only place that reads the environment. Everything else takes configuration as an argument.

## Not here yet

This is the Phase 0 scaffold. It boots, serves `/healthz`, and proves the wiring. The rest of Phase 0 follows in its own work items:

- Module runtime, event bus, and entitlements registry. `kelpie.config.ts` arrives with them.
- Database tables and migrations. `packages/server/src/schema/` is empty on purpose, and the boot sequence does not run migrations yet.
- Auth, sessions, workspaces, and API keys.
- The integration test harness. Unit tests exist; nothing tests against a real database yet.
- `LICENSE`. The project is AGPL-3.0-only per `modules.md`, and the package manifests declare it, but the licence text is not committed.

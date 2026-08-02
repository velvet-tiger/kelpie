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

## Database

Tables live in the module that owns them, under `packages/server/src/modules/<id>/schema.ts`. `packages/server/src/schema/index.ts` re-exports all of them; that barrel is what Drizzle and Drizzle Kit read.

Core shares one migrations directory, `packages/server/migrations`. A module outside core brings its own, and the runner gives each directory its own migrations table.

The service applies pending migrations at boot. Pass `--no-migrate` to skip that, for deployments where a release step migrates once and many instances then start.

After changing a table:

```bash
npm run db:generate
```

That writes a new SQL file into `packages/server/migrations`. Read it before committing. The next boot applies it.

Two things that will catch you out:

- **Never regenerate `0000_initial_schema.sql`.** Its first line creates the `citext` extension. Drizzle Kit does not manage extensions, so a regenerated file drops that line and every `citext` column fails to create. New migrations are additive files; regenerating the first one is never the right fix.
- **A blocked delete raises SQLSTATE `23001`, not `23503`.** Postgres uses `23001` for an explicit `ON DELETE RESTRICT` and reserves `23503` for references violated without one. Use `isReferenceViolation` rather than comparing codes yourself.

Integration tests need `TEST_DATABASE_URL`. The database is created automatically if it does not exist, and tests truncate it between cases. Without that variable the integration suites skip rather than fail, so `npm test` still works with no Postgres running.

## Modules

Features register through the module runtime. Core features use the same runtime modules do, so the extension points cannot rot.

A module is one object:

```ts
import type { KelpieModule } from '@kelpie/server'
import { z } from 'zod'

export const smtpEmail: KelpieModule = {
  id: 'smtp-email',
  requires: ['workspace'],
  async register(context) {
    const config = context.config(z.object({ SMTP_HOST: z.string() }))

    context.routes((router) => {
      router.get('/email/status', (c) => c.json({ host: config.SMTP_HOST }))
    })

    context.schema(tables, '/abs/path/to/migrations')
    context.mcp.tool({ name: 'email.status', description: '…', inputSchema, invoke })
    context.webhookEvents(['email.sent'])
  },
}
```

`apps/kelpie/kelpie.config.ts` is the only module list for this assembly. The cloud repo keeps its own.

Routes mount under `/v1` and are public API like every other endpoint. Module config is validated against the environment at boot. Modules register in dependency order, and boot stops on a duplicate id, an unmet `requires`, a dependency cycle, invalid module config, or a `register` that throws. Every failure names the module.

MCP tools share the input schema with their REST route, and the runtime parses arguments before the tool body runs. A bad argument fails with the same `validation_failed` error the REST surface returns.

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

The rest of Phase 0 follows in its own work items:

- Event bus and entitlements registry. `ModuleContext` gains `events` and `entitlements` when they land; it does not carry stubs for them now.
- `npm run seed`. The demo dataset in `mockups/src/data/seed.ts` has not been ported.
- Auth, sessions, workspaces, and API keys. The tables exist; nothing writes to them yet.
- The MCP endpoint (Phase 3). Tools register into the runtime today and have no transport.
- Auth, sessions, workspaces, and API keys.
- The integration test harness. Unit tests exist; nothing tests against a real database yet.
- `LICENSE`. The project is AGPL-3.0-only per `modules.md`, and the package manifests declare it, but the licence text is not committed.

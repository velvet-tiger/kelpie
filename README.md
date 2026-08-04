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

6. Create an account. There is no signup form yet — that page belongs to the auth
   UI port — so the first account is made through the API.

   ```bash
   curl -s -X POST http://localhost:5173/v1/auth/signup -H 'Content-Type: application/json' -d '{"email":"you@example.com","name":"Your Name","password":"a-real-password"}'
   ```

   Expected: `{"account":{...},"active_workspace_id":null}`. A `409` means the
   address is already registered; sign in with it instead.

7. Open http://localhost:5173, sign in with that address, and create a workspace
   when asked. That lands on People, and the sidebar has People and Companies.

## Layout

```
packages/schemas/  @kelpie/schemas — the /v1 wire contract as Zod schemas. Depends on
                   Zod and nothing else, so the browser and the cloud repo can both use it.
packages/server/   @kelpie/server — the service as a library. Exports the Hono app,
                   config loader, database client, errors, ids, and logger.
packages/ui/       @kelpie/ui — the React application: API client, query layer,
                   components, and pages.
apps/kelpie/       The open-source assembly. Boots the server, builds the UI.
```

`@kelpie/server` never starts a listener on import. `apps/kelpie` is the executable. The cloud repo assembles the same packages with private modules, per `modules.md`.

## The UI data layer

The UI is one more API consumer. There is no private endpoint and no shared
in-process state with the server; every screen goes through `/v1`.

Three pieces, in `packages/ui/src/api/`:

- **`client.ts`** speaks `api.md`: the list envelope, the error shape, the write
  verbs. Every method takes a `Decoder<T>` and returns what the decoder produced,
  so no response is asserted into a type it was not checked against.
- **`@kelpie/schemas`** supplies those decoders. One module per resource holding
  the record the UI works with, a Zod schema that parses the `snake_case`
  response into it, and a function that builds a request body back out. The
  `snake_case` ↔ `camelCase` mapping `api.md` describes happens there and nowhere
  else.
- **`resource.ts`** turns a path plus a decoder into the five hooks a CRM
  resource needs, over TanStack Query. Optimistic updates and their rollback live
  here once rather than in each page.

A page imports `usePeople`, `usePerson`, `useUpdatePerson` and so on, and never
imports `@tanstack/react-query`. That keeps page code short, and it means the
cache library can be replaced without touching a page.

`@kelpie/server` consumes the same package, so a fixed value set like
`COMPANY_STAGES` is one list rather than three copies: the check constraint, the
route's Zod enum, and the browser's decoder all read it. Each resource's
integration tests parse their `POST`, `GET`, list and `PATCH` responses through
the shared schema, so a renamed or removed field fails there rather than in a
browser. An added field still passes, because changes within `/v1` are additive
only.

**The dependency runs server → schemas and never the reverse.** `@kelpie/schemas`
having any dependency but Zod would put Drizzle, postgres.js and Node built-ins
back in the browser bundle.

Two things to know before adding a resource:

- **A join resource declares `alsoInvalidates`.** `GET /v1/people?company_id=` is
  a list of people whose membership a Position decides, so creating one has to
  mark the people and companies lists stale as well. Without it a company page
  renders a new row against a name it never fetched.
- **A list filtered by a set of ids passes `{ enabled }`.** It has nothing to ask
  until the ids are known, and asking with the filter omitted answers with every
  record in the workspace. `usePeopleDirectory` and `useCompanyHeadcounts` in
  `src/pages/positionDirectory.ts` are the worked example.
- **`undefined` and `null` are not the same.** `undefined` means "not sent",
  `null` means "clear this field". `definedFields` in `@kelpie/schemas` drops the
  former; the optimistic merge in `resource.ts` leaves the existing value alone
  for it.

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

A module's UI half is a separate list, `apps/kelpie/kelpie.ui.config.ts`, because the server config is imported by the Node entry point and a UI module brings React with it. It contributes nav items, whole routes, record tabs, sidebar cards, dashboard cards and integration catalog entries, and can replace a core component outright:

```ts
export const gmailUi: UiModule = {
  id: 'gmail-sync',

  register(context) {
    context.nav('primary', { id: 'gmail', label: 'Gmail', to: '/gmail', order: 250 })
    context.route({ path: '/gmail', element: <GmailSettings /> })
    context.recordTab('person', { id: 'threads', label: 'Email', render: (r) => <Threads id={r.recordId} /> })
    context.dashboardCard({ id: 'unread', render: () => <Unread /> })
    context.override(recordHeader, GmailRecordHeader)
  },
}
```

Open source ships no UI modules. Every slot renders nothing, which is how core pages are meant to look.

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
| `API_PORT` | The same number again, for the Vite dev server's `/v1` proxy. It needs its own name because a launcher sets `PORT` to the port it wants Vite on, and Vite would then proxy to itself |
| `DATABASE_URL` | `postgres://` or `postgresql://` connection string |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| `EMAIL_PROVIDER` | `log`. Writes invites and password resets to the log instead of sending them. Real providers ship as modules |
| `EMAIL_FROM` | The address transactional mail comes from |

`TEST_DATABASE_URL` is separate: it is read only by the test harness, and only the integration suites use it. Without it they skip.

`packages/server/src/lib/config.ts` is the only place that reads the environment. Everything else takes configuration as an argument.

## What works

The Phase 0 backend, plus the CRM resources below. Every endpoint here has integration tests against a real Postgres.

| Area | Surface |
| --- | --- |
| Accounts | `POST /v1/auth/signup`, `login`, `logout`, `GET /v1/auth/me` |
| Sessions | `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id` |
| Passwords | `PATCH /v1/auth/password`, `POST /v1/auth/password-reset` and `/confirm` |
| Workspaces | `POST /v1/workspaces` (seeds the starter handbook and pipeline stages), `GET`, `PATCH`, `DELETE /v1/workspaces/:id?slug=` |
| Membership | `GET`, `PATCH` and `DELETE /v1/workspaces/:id/members[/:member_id]` |
| Invites | `POST` and `GET /v1/workspaces/:id/invites`, `POST .../invites/:invite_id/resend`, `DELETE .../invites/:invite_id`, `POST /v1/invites/accept` |
| API keys | `POST /v1/api-keys`, `GET /v1/api-keys?kind=`, `DELETE /v1/api-keys/:id` |
| People | `GET`, `POST /v1/people`, `GET`, `PATCH`, `DELETE /v1/people/:id`. Filters `?q=` and `?company_id=` |
| Companies | `GET`, `POST /v1/companies`, `GET`, `PATCH`, `DELETE /v1/companies/:id`. Filters `?q=` and `?person_id=` |
| Positions | `GET`, `POST /v1/positions`, `GET`, `PATCH`, `DELETE /v1/positions/:id`. Filters `?person_id=` and `?company_id=` |
| Opportunities | `GET`, `POST /v1/opportunities`, `GET`, `PATCH`, `DELETE /v1/opportunities/:id`. Filters `?q=`, `?kind=`, `?company_id=` and `?stage_id=` |
| Partnerships | `GET`, `POST /v1/partnerships`, `GET`, `PATCH`, `DELETE /v1/partnerships/:id`. Filters `?q=`, `?kind=`, `?company_id=`, `?stage_id=` and `?person_id=` |
| Raises | `GET`, `POST /v1/raises`, `GET`, `PATCH`, `DELETE /v1/raises/:id`. Filters `?q=`, `?company_id=`, `?stage_id=` and `?person_id=` |
| Roles | `GET`, `POST /v1/roles`, `GET`, `PATCH`, `DELETE /v1/roles/:id`. Filters `?q=` and `?status=` |
| Candidates | `GET`, `POST /v1/candidates`, `GET`, `PATCH`, `DELETE /v1/candidates/:id`. Filters `?role_id=`, `?person_id=` and `?status=` |
| Decisions | `GET`, `POST /v1/decisions`, `GET`, `PATCH`, `DELETE /v1/decisions/:id`. Filters `?q=`, `?target_type=` and `?target_id=` |
| Handbook | `GET`, `POST /v1/handbook_pages`, `GET`, `PATCH`, `DELETE /v1/handbook_pages/:id`. Filters `?q=` and `?slug=` |
| Forms | `GET`, `POST /v1/forms`, `GET`, `PATCH`, `DELETE /v1/forms/:id`. Filters `?q=` and `?status=`. Plus `GET /v1/forms/:id/submissions` and `GET /v1/forms/:id/embed` |
| Public forms | `POST /v1/public/forms/:public_key/submit` and `GET /v1/public/forms/:public_key/embed`. No credentials, any origin |

Every list takes `?limit=`, `?sort=` and `?cursor=`. Cursors are keysets bound to the sort that issued them.

**Id filters repeat to name a set:** `?person_id=per_1&person_id=per_2` matches either, up to 200 ids. It is what replaces the `include` expansion this version does not have: a list page showing a related column resolves it in one extra request rather than one per row. A blank value or more than 200 is `422`.

A job title lives on Position and nowhere else, so a person can hold one at more than one company. `?q=` on people matches the titles they hold and the companies they hold them at, which is what the mockup's filter box does.

Hiring state lives on Candidate, the Person↔Role link, for the same reason: one person can be interviewing for one role and in the nurture pile for another. `interview_stage` is null unless the status is `in_process`, and the API keeps that true — leaving the process clears the stage, rejoining it restores the first one, and a stage that contradicts the status is a `422`.

Forms are the one public surface. Managing them takes credentials like everything else; submitting one takes nothing but the form's `public_key`, because the caller is a stranger's browser on a stranger's website. Everything under `/v1/public` is mounted outside the credentialled routes and answers any origin without allowing credentials, so a browser never attaches a signed-in reader's session cookie to one. A submit upserts the Person by email, the Company by domain and then by name, the Position that carries the title, and optionally a Deal. The merge fills blanks and never overwrites: an inbound "Alex" does not replace the "Alex Rivera" the team recorded. A paused form answers `409`, and answers without a usable address answer `422`. `GET /v1/forms/:id/embed` hands back the iframe and script snippets to paste into a site; the page they point at is server-rendered from the form itself, so embedding it does not pull the CRM bundle into somebody else's marketing site.

**A company is never inferred from an email domain.** Only a field mapped to `company.domain` sets one. An email domain is not a company identifier: one company sends from several, a consumer address belongs to none, and two people at unrelated businesses can share one, so inferring it merges records that were never the same company. A Deal belongs to a Company, so a form with `create_deal` on and no `company.name` or `company.domain` field is refused at `422` rather than left to quietly never create the deals it promises.

A form carries its fields, and a write replaces the whole list — field ids never appear in a request, and positions come from the array's order. A list identical to the stored one is not a write, so ids survive a save that changed nothing, which matters because a stored answer is keyed by field id.

The handbook is a tree the caller rebuilds from `parent_id` and `sort_order`; a page's `sort_order` positions it among its siblings and means nothing across the whole set, so the list sorts by title. `PATCH` with a `parent_id` or a `sort_order` is a move, and the API renumbers both sibling sets so positions stay contiguous from 0. In the sidebar one gesture does both: dragging a page sideways indents or lifts it where it stands, and a drag that ends where it started writes nothing. It nests five levels, and a move that would push a page *or its own subpages* past that is a `422`, as is nesting a page under itself or one of its subpages. A page's `slug` is the stable handle `agent-tasks.md` names pages by, so renaming a page leaves it alone; moving it on purpose is a separate field, and a collision is a `409`. Deleting a page deletes every page under it.

Underneath: the module runtime with its credentialled and public route contributions, a typed event bus with after-commit publication, the entitlements registry, 36 tables with migrations, and an integration harness that creates and truncates its own database.

Passwords are argon2id. Session, invite, reset, and API key secrets are stored as SHA-256 hashes. Credentials arrive as either a session cookie or a `Bearer kp_live_…` / `kp_user_…` key.

In the browser: People and Companies, list and detail, against those endpoints. Filtering, inline editing, creating, deleting, and linking a person to a company through a Position all work end to end. Detail pages render the `person` and `company` record-tab slots, and the sidebar renders module nav items, so a UI module has somewhere to land from the start.

Forms have a list and a four-tab detail page: submissions with links to what each one created, a drag-ordered field builder, settings, and the embed snippets. The builder is the one screen in the app that saves explicitly rather than per keystroke, because a write replaces the whole field list and committing on every character would reissue every field id. It refuses to send a list the API would reject, and shows why beside the field responsible.

Workspace administration is under Admin in the sidebar. **Workspace** carries the settings, including the two agent identity strings: `tagline` is the short line an agent loads first and `one_liner` is what the company does. Clearing either sends `null`, so an emptied field is no tagline rather than an empty one. The slug is editable and a collision is a `409`.

**Team** invites by email, changes roles, and removes members. Every rule is the API's, not the page's: a member who tries anyway gets `403`. The owner cannot be demoted or removed, and ownership moves only by being given away, which makes the outgoing owner an admin in the same transaction. Removing somebody who still owns Deals, Opportunities, Partnerships, Raises, Plan items, Decisions or Notes answers `409` naming each type and how many, per `schema.md`'s restrict rule; reassign them first. An invitation's status is derived from `expires_at` rather than stored, so a stale one reads as expired with nothing sweeping the table. Resending issues a new token and retires the old link. Revoking deletes the row, which is what actually kills the link already in somebody's inbox.

Deleting a workspace is the owner's alone and takes the slug as confirmation, in the request rather than only in the browser, so an accidental `DELETE` at the right id does nothing. It cascades every table that carries a `workspace_id`. Accounts are global and survive it.

The emailed invitation lands on `/join?token=…`, which accepts as the signed-in account. Signing in from there returns to the invitation instead of the CRM.

## Not here yet

- **Most of the UI.** People, Companies, Positions, Deals, Opportunities, Fundraising, Partnerships, Hiring, Handbook, Planning, Decisions, Forms, and the Workspace and Team admin pages are ported. Everything else in `mockups/` is not: the dashboard, search, the remaining admin pages and the account pages all wait for their endpoints.
- **Role enforcement outside workspace administration.** Administration is gated at `admin`, and API keys already were. Every CRM resource is open to any member, which is what the specs describe; no document defines a read-only role. Narrowing that is a product decision, not a missing check.
- **Agent tasks on a handbook page.** The mockup's handbook header carries an Agent tasks button. It arrives with the agent task registry in Phase 3, like every other record's.
- **The rest of the auth pages.** Sign-in, first-workspace and join exist so the CRM pages can be reached and an invitation can be accepted. Signup, password reset, the onboarding wizard, and the account security page are a separate feature and replace the first two.
- **Leaving a workspace, and the last owner.** An admin can remove themselves; the owner cannot, and has to hand ownership over first. An owner who is the only member has no way out except deleting the workspace.
- **`npm run seed`.** The demo dataset in `mockups/src/data/seed.ts` has not been ported.
- **`Idempotency-Key`.** `api.md` says `POST` endpoints accept it and `idempotency_keys` exists, but nothing reads the header yet. It needs a migration of its own (`response` is `NOT NULL`, and reserve-then-fill needs null), so it is a feature rather than a rider on the first CRM route.
- **The MCP endpoint** (Phase 3). Tools register into the runtime today and have no transport.
- **The integrations framework and an SMTP module** (Phase 4). `EMAIL_PROVIDER=log` is the only provider core ships.
- **A CI workflow.** The scripts are ready; nothing runs them on push.
- **A copyright holder.** `LICENSE` is the verbatim AGPL-3.0 text, but no file states who holds the copyright. `modules.md` depends on that: proprietary cloud modules are only possible while we own the core copyright, and external contributions need a CLA before the first outside PR.

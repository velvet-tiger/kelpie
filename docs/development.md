# Developing Kelpie

This is a guide to working on the `kelpie-crm` repository itself: the package
layout, the UI data layer, the database, the module system, the full command
reference, and how packaging and releasing work.

If you want to run Kelpie rather than build it, see the [README](../README.md)
instead. For product direction and the wire-level specs, see `brief.md`,
`roadmap.md`, `architecture.md`, `api.md`, `schema.md` and `modules.md`
alongside this repository.

## Layout

```
packages/schemas/  @kelpie/schemas — the /v1 wire contract as Zod schemas. Depends on
                   Zod and nothing else, so the browser and the cloud repo can both use it.
packages/server/   @kelpie/server — the service as a library. Exports the Hono app,
                   config loader, database client, errors, ids, and logger.
packages/ui/       @kelpie/ui — the React application: API client, query layer,
                   components, and pages.
packages/create-kelpie/
                   create-kelpie — the scaffolder behind `npm create kelpie`.
                   Templates in templates/, generator in src/.
apps/kelpie/       The open-source assembly. Boots the server, builds the UI.
```

`@kelpie/server` never starts a listener on import. `apps/kelpie` is the executable. The cloud repo assembles the same packages with private modules, per `modules.md`.

`apps/kelpie` is the dev harness and the reference assembly, not the thing a self-hoster runs. They get their own directory from `npm create kelpie`. The two are the same shape and drift apart if nobody looks, which is why `verify:packaging` builds the scaffolded one rather than this one.

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

`invoke` is handed the caller as its second argument, the way a route handler resolves one, because every service call is authorized against an actor and scoped to its workspace. The `/mcp` endpoint resolves it once per request from the bearer key. A tool that a resource can build the ordinary way should go through `registerCrudTools` in `packages/server/src/modules/crudTools.ts`, which turns a service and the pieces its routes already carry into the five verbs; the ones written out by hand are the resources whose shape does not fit, and each says why at the top of its `tools.ts`.

### Turning modules on or off

A module is `structural` or it is not. A structural module (`auth`, `workspace`, `api-keys`, `activities`, `people`, `companies`, `plans`, `decisions`, `dashboard`, `notes` and `pipelines` in `coreModules` today) registers every route and MCP tool unconditionally and can never be disabled. Every other module is toggleable: the registration pass declares a `module.<id>` entitlement capability for it and gates its routes and tools behind that capability, so a disabled module answers `entitlement_required` on both surfaces rather than just disappearing from the UI. A module says nothing to opt in; `structural` defaults to false, so a module added later is toggleable without its author doing anything.

A workspace admin turns a toggleable module on or off from **Admin → Modules**, backed by `GET`/`PATCH /v1/workspaces/:id/modules`. No row for a module means enabled, which is the state every workspace starts in.

A deploy can lock specific modules on or off for every workspace it serves, ahead of what any workspace's own settings say:

```bash
cp kelpie.modules.json.example kelpie.modules.json
```

then edit it and point `KELPIE_MODULE_CONFIG_PATH` at the copy. Naming a module this build does not have, or a structural one, fails boot the same way an unmet `requires` does. A module the file locks shows on the settings screen as disabled with its checkbox greyed out, not hidden, so an admin can see the choice exists and is not theirs to make.

## Commands

`make` lists every target. `make setup`, `make dev`, `make test`, `make up`/`down`, `make reset`, `make psql` and `make status` are covered in the [README](../README.md). The rest of the day-to-day surface is `npm` scripts.

Each `make` target that needs the database depends on `up`, so the port in
`.env.local` is refreshed before anything reads it. The npm scripts below assume
the database is already running.

| Command | Does |
| --- | --- |
| `npm run dev` | Picks a free port for each process, then starts the API with file watching plus the Vite dev server |
| `npm run dev:processes` | The two processes on their own, on whatever ports the environment already names. `npm run dev` runs this once it has chosen them |
| `npm run build` | Compiles the three packages to JavaScript, then the web bundle |
| `npm run verify:packaging` | Scaffolds a project from the packed tarballs and runs it. Needs Postgres. See [Packaging](#packaging) |
| `npm run release <version>` | Versions, verifies, commits and tags a release. See [Releasing](#releasing) |
| `npm run lint` | oxlint across the repository. Silent means clean |
| `npm run typecheck` | `tsc` over every workspace |
| `npm test` | Vitest unit tests |
| `npm run db:up` / `npm run db:down` | Local Postgres container. Both call the matching `make` target, so `db:up` also refreshes `.env.local` |
| `npm run db:generate` | Writes a new migration from the schema barrel. See [Database](#database) |

### Environment file precedence

Two files, and every entry point reads them in the same order: `.env` first for
the checked-in defaults, then `.env.local` for the database port `make up`
resolved. A variable already in the environment beats both files, which is what
CI relies on.

The mechanism differs by loader, and one of them has a trap in it:

- `process.loadEnvFile` keeps the **first** value it sees, so `.env.local` is
  loaded first (`vitest.config.ts`, `apps/kelpie/src/dev.ts`).
- `--env-file` takes the **last** file given, so `.env.local` is passed last.
- Under `--watch`, mixing `--env-file` with `--env-file-if-exists` inverts that:
  both files load, but the plain `--env-file` wins whatever the order. Keep every
  flag in one command the same variant. The `dev` script uses
  `--env-file-if-exists` for both, which is why `.env` is optional there; a
  missing one surfaces as a config error listing the variables, not a Node crash.

`apps/kelpie/src/dev.ts` loads both files itself before spawning, because a
variable it holds is inherited by the API child, and an inherited variable beats
`--env-file`. Loading `.env` first there would pin the child to a stale database
port no matter what its own flags say.

`packages/server/src/lib/config.ts` is the only place that reads the environment. Everything else takes configuration as an argument.

## Packaging

`@kelpie/schemas`, `@kelpie/server`, and `@kelpie/ui` are installed by assemblies
other than `apps/kelpie`. Two are planned: the private `kelpie-cloud` repo, which
adds proprietary modules to its own module lists, and whatever `npm create
kelpie` writes for a self-hoster. Both install the published packages. Neither is
a checkout of this repo, and core is never vendored or forked into them.

That means the packages have to ship JavaScript. Node refuses to strip types from
a file under `node_modules`, so a package whose entry point is TypeScript works in
this workspace and nowhere else.

They also have to keep running as TypeScript in here, because a build step
between editing a file and seeing the change is a tax on every day of work.

Both, through a custom export condition:

```json
"exports": {
  ".": {
    "kelpie-source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

Everything in this repository asks for `kelpie-source` and gets the source:
`node --conditions=kelpie-source` in the npm scripts, `resolve.conditions` in the
Vite and Vitest configs, `customConditions` in `tsconfig.base.json`. Nothing
outside asks for it, so an installed copy gets `dist`. `dist` is git-ignored and
only `npm run build` writes it; a stale one cannot affect a dev run or a test.

The failure this creates is a quiet one. Everything keeps working in the
workspace while the published artifact is broken, and only an out-of-tree install
can tell.

`npm run verify:packaging` does that, by walking the path a self-hoster walks.
It builds and packs all four packages, runs `create-kelpie` to scaffold a
project, installs the tarballs into it, and then:

- imports `@kelpie/server` from the install, so the compiled entry point is the
  one that shipped
- checks `coreMigrationsDirectory` reaches real migrations, which sit outside
  `dist` and only ship because `files` names them
- runs `npm run dev` and asserts the dev server proxies `/healthz` to the API,
  serves `/signup`, and accepts a signup through the proxy
- builds the web bundle and asserts the Tailwind theme utilities are in the CSS

The scaffolder writes that project rather than the script hand-rolling one, so
the generated manifest's dependency list is under test too. A devDependency
missing from the template surfaces here as a failed build rather than as a
self-hoster's first five minutes.

It needs Postgres, through `TEST_DATABASE_URL`. `make up` writes it.

Run it after changing a package's `exports`, `files`, or build, or anything under
`packages/create-kelpie/templates/`. This repository has no CI yet; when it does,
this belongs in it, because the check is the only thing standing between a
routine edit and a broken release.

### Working on core and a consuming repo together

A consuming repo installs published versions, so an unreleased core change is
invisible to it. `npm link` fixes that, and the export condition means it fixes
it properly:

```bash
cd kelpie-crm/packages/server && npm link
cd ../../../kelpie-cloud && npm link @kelpie/server
```

`npm link` symlinks rather than copies, so the linked package resolves through
`kelpie-source` exactly as it does in here. Run the consuming service with
`--conditions=kelpie-source` and editing a file in `packages/server` restarts it,
with no build and no publish in between. That is the same loop `apps/kelpie` has,
which is why a monorepo spanning the two repos would not buy anything.

Unlink with `npm unlink @kelpie/server` and reinstall before trusting a test run
that is meant to reflect the published packages.

## Releasing

`@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`, and `create-kelpie` share one
version and go out together. An assembly pins the first three, and a mismatched
pair has no meaning. `create-kelpie` joins them because a scaffold pins core at
the scaffolder's own version, so publishing it alone would write a project
asking for a core version that does not exist. `@kelpie/app` carries the same
number but is private and never published.

Write the changelog entry first, then:

```bash
npm run release 0.2.0
```

That sets the version in every manifest, rewrites the internal `@kelpie/*`
ranges to match, refreshes the lockfile, runs lint, typecheck, the full suite and
`verify:packaging`, then commits and tags `v0.2.0`. It refuses a dirty tree, a
branch other than `main`, a tag that already exists, and a version with no
`## [0.2.0]` section in `CHANGELOG.md`. If any check fails it rolls the version
changes back and tags nothing.

The ranges have to move with the versions. They are carets, so `^0.1.0` does not
match `0.2.0`, and bumping versions alone would send npm to the registry looking
for a version that is not published yet.

Publishing is separate, because it cannot be undone. npm allows unpublishing a
new package for 72 hours and not at all after that.

```bash
npm publish --workspace packages/schemas --workspace packages/server --workspace packages/ui --workspace packages/create-kelpie
```

`npm run release 0.2.0 --publish` does both in one step, once you trust it.

Credentials are local. `npm login` once, or set `NPM_TOKEN` with a granular
access token scoped to the `@kelpie` scope. Nothing in this repository stores a
token, and no CI publishes. With 2FA enabled on publish, npm prompts for a
one-time code.

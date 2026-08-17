# Changelog

All notable changes to `@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`, and `create-kelpie`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

The packages share one version and release together. An assembly pins core, and a mismatched pair has no meaning. `create-kelpie` writes a project pinning core at its own version, so it moves with them. A release note that names no package applies to all of them.

While the major version is `0`, a minor bump may break the API.

## [0.5.2] - 2026-08-17

### Fixed

- **`@kelpie/server`** — the `workspace.access` gate (0.5.1) now exempts
  `DELETE /v1/workspaces/:id`. Without this, a suspended workspace's owner
  got a `403` trying to delete their own workspace, with no way out of it
  until an operator reactivated it first. Every other verb and every
  sub-resource under `/v1/workspaces/:id` stays gated.

## [0.5.1] - 2026-08-17

### Added

- **`@kelpie/server`** — a new `workspace.access` flag capability, checked
  once per request by a blanket `/v1` and `/mcp` middleware. `/v1/auth/*`
  and the workspace-switch endpoint are exempt, so a member can still see
  why they are locked out or switch to a different workspace. No grant
  provider answers this capability in a self-hosted assembly, so
  `EntitlementRegistry`'s open-source default applies and nothing changes
  for anyone without a module that supplies one. Built for the cloud
  assembly's operator module, which can now enforce a real workspace
  suspension instead of only recording one in its own tables.

## [0.5.0] - 2026-08-15

### Changed

- **Breaking, `@kelpie/server` and `@kelpie/schemas`** — the server builds
  every emailed link (verification, password reset, invitation) itself from a
  new required `APP_BASE_URL` variable. The `verify_url_template`,
  `reset_url_template`, and `invite_url_template` request fields are removed
  from the wire schemas, the routes, and the MCP invite tool; sending one now
  answers `422`. Taking the link target from the request let an
  unauthenticated caller point a genuine Kelpie email at their own host,
  which is an account-takeover path. Every deployment must set
  `APP_BASE_URL` before upgrading; boot refuses to start without it.
- **Breaking, `@kelpie/server`** — a public form submit no longer returns the
  upserted person and company ids. A Kelpie id is a ULID whose timestamp let
  an anonymous caller tell a pre-existing contact from a new one. The public
  response carries the submission id and the thank-you copy; the stored
  submission, read over the authenticated API, still holds the record ids.

### Added

- **`@kelpie/server`** — modules can declare routes and middleware on the app
  itself, outside `/v1`: `ModuleContext.appRoute(method, path, handler)` and
  `ModuleContext.appMiddleware(pattern, handler)`. Declarations carry their
  real, full paths; `createApp` applies every declared middleware, then every
  declared route, so a pattern covers matching routes from every module. No
  actor resolution, workspace scoping, or `module.<id>` gate applies: a
  surface declared this way owns its own access rules. Paths at or under
  `/v1`, `/mcp`, or `/healthz` are refused at boot. Built for the cloud
  assembly's operator surface, which lives entirely in its own module.
- **`@kelpie/server`** — `serveWebBundle` takes `apiPrefixes`, extra prefixes
  the SPA fallback must leave to the API, for assemblies whose modules answer
  outside `/v1`.

### Security

- Login attempts are now also budgeted per account, keyed on the normalised
  email, so credential stuffing spread across many IPs is capped for the
  targeted address. A new optional `TRUSTED_PROXY_HOP_COUNT` reads the real
  client IP from `X-Forwarded-For` up to the deployment's trusted hops;
  without it, every caller behind a proxy shared one rate-limit bucket. The
  verify-email confirm and public form embed endpoints are now metered.
- An optional egress guard (`BLOCK_PRIVATE_EGRESS=true`) refuses webhook and
  agent-task deliveries to private, loopback, link-local, and reserved
  addresses, closing the SSRF path from customer-supplied endpoints to
  cloud metadata services and internal hosts. Off by default: a self-hosted
  Kelpie legitimately posts to internal automation. A blocked target records
  a failed delivery rather than crashing, and redirects stay closed.
- The public form routes now honour the `module.forms` entitlement, so a
  workspace that switched the module off no longer accepts submissions or
  serves the embed.
- Cross-module CRM queries carry explicit workspace predicates as defence in
  depth; they previously relied on record-id uniqueness alone.
- The session cookie's `Secure` flag is set outside development, not only in
  production.

### Fixed

- The idempotency middleware no longer resolves an actor on unauthenticated
  auth endpoints: `POST /v1/auth/login` or `/signup` with an
  `Idempotency-Key` header answered `401` before the handler ran.

### Notes

- Between 0.4.1 and this release, main briefly carried an operator-specific
  surface in core (`SUPERUSER_EMAILS`, a superuser guard, a fixed
  `/operator/api` mount). It was reworked into the generic declarations above
  before any release; no published package ever contained it. The cloud
  assembly's `operator` module now owns all of it.

## [0.4.1] - 2026-08-12

### Added

- **`@kelpie/server`** — `EMAIL_PROVIDER=smtp`, backed by `nodemailer`, behind
  the existing `EmailSender` port. `log` was the only option core shipped, so
  a self-hosted install had no way to actually deliver an invite or a
  password reset. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and
  `SMTP_PASSWORD` are required only when `EMAIL_PROVIDER=smtp`, matching the
  config layer's no-defaults rule.
- **`create-kelpie`** — the scaffolded `.env` and README document the new
  provider and its variables, and no longer state that Kelpie cannot send
  email at all.

### Notes

- A vendor-managed provider (Resend, Postmark, Mailtrap, SendGrid) needs an
  account core does not manage, so it belongs in a module rather than this
  switch, per `modules.md`'s split test.

## [0.4.0] - 2026-08-12

### Removed

- **`@kelpie/server`, `@kelpie/ui`** — the integration framework is now cloud,
  not core. Integrations need vendor accounts the cloud manages, and a
  self-hosted CRM is not broken without a catalog page listing providers it
  cannot connect to, so core no longer carries the half it had. `modules.md`
  records the change.

  Gone from `@kelpie/server`: the `integration_connections` table, its
  `integrations` module, and the `integrationConnection` id prefix. Gone from
  `@kelpie/ui`: `IntegrationProvider`, `IntegrationCategory`,
  `INTEGRATION_CATEGORIES`, `useIntegrationProviders`, the
  `integrationProvider()` contribution method, and `integrationProviders()` on
  `UiExtensions`.

  Migration `0017` drops the table. Nothing ever wrote to it, in core or
  anywhere else, so no data is lost. A module contributing a provider catalog
  now owns the descriptor type as well, which is where it belonged.

### Fixed

- **`@kelpie/ui`** — the `nav.account` slot rendered nowhere. `Shell.tsx` reads
  `primary` and `admin` and never read `account`, so a module contributing an
  account tab got a page with nothing anywhere pointing at it. `AccountLayout`
  now merges the slot into its tab strip, and core numbers its own three tabs in
  hundreds so a module can land between them. Present since the registry landed.
- **`@kelpie/ui`** — a module route under `account/` now renders inside
  `AccountLayout` rather than as a sibling of it, so it keeps the account tab
  strip instead of losing it the moment its own tab is clicked. Routes outside
  that prefix mount under the shell exactly as before.
- **`@kelpie/ui`** — the shell's sidebar and the account tab strip now share one
  rule for hiding the nav items of a disabled module, `useVisibleNavItems`. The
  filter previously lived in `Shell.tsx` alone, so the new account tabs would
  have kept showing a module the workspace had switched off, leading to a page
  that answers `403`.

## [0.3.1] - 2026-08-11

### Changed

- **`@kelpie/server`, `@kelpie/ui`** — optional properties that accept
  `undefined` now say so, as `prop?: T | undefined`. This affects
  `ModuleRuntimeOptions`, `UpdateWorkspaceInput`, the UI's list filter types, and
  the shared component props. Passing `undefined` where the value was previously
  only allowed to be absent now compiles, which is what an assembly building
  options from `readModuleConfigFile` was already doing. Nothing narrows, so no
  existing call breaks.

### Fixed

- **`create-kelpie`** — a scaffolded project failed its own `npm run typecheck`.
  The generated `tsconfig.server.json` sets `exactOptionalPropertyTypes`, under
  which passing `moduleConfig: undefined` is not the same as omitting the key.
  Present since `0.2.0`.
- **`create-kelpie`** — a scaffolded `vite build` demanded `API_PORT`, which only
  the dev server's proxy uses. Any build without a `.env` beside it failed, which
  is every container build, since the image leaves `.env` out. Present since
  `0.2.0`.

## [0.3.0] - 2026-08-11

### Added

- **`@kelpie/server`** — `serveWebBundle(app, { directory })`, which serves a
  built web bundle from the same origin as the API. Nothing did this before:
  `createApp` answers `/v1`, `/v1/public`, `/mcp` and `/healthz` and serves no
  pages, so a deployed assembly answered API calls and showed a blank page to
  every browser. The Vite dev server was hiding it, because it builds the pages
  and proxies the API in one tool, and only the first of those two jobs is
  development-only.
- **`@kelpie/server`** — `WEB_BUNDLE_DIR`, optional. Set it to the built bundle
  and one process serves the pages and the API. Leave it unset in development.
  Boot fails when it names a directory holding no `index.html`, so a deployment
  whose build did not run stops rather than serving invisible pages.
- **`create-kelpie`** — the generated entry point calls `serveWebBundle`, and
  the generated README has a Deploying section covering the production build and
  `--no-migrate` for more than one instance.

### Notes

- Upgrading is `npm update`. Nothing changes for an assembly that does not set
  `WEB_BUNDLE_DIR`, which includes every development setup.
- A deep link such as `/people/per_01J…` answers with `index.html`, because the
  app decides what to draw from the address. Unknown paths under `/v1`, `/mcp`
  and `/healthz` are left to the API, so a misspelled endpoint is still a JSON
  error rather than a web page with a 200.
- `@hono/node-server` is now a dependency of `@kelpie/server` rather than only
  of the assemblies. It supplies the static file middleware.
- `npm run verify:packaging` gained a fifth check: it restarts the scaffolded
  service with no dev server in front of it and asserts the API serves what it
  built. The four checks before it all passed while this was broken.

## [0.2.0] - 2026-08-10

### Added

- **`create-kelpie`** — `npm create kelpie@latest` scaffolds a self-hosted
  install: two module lists, two entry points, a Vite config, and a `.env` with
  an encryption key generated for that project. `@kelpie/server` and
  `@kelpie/ui` arrive as ordinary dependencies, so there is nothing to clone and
  upgrading is `npm update`. Prompts for what it cannot infer, and takes flags
  for every answer so it runs unattended.

### Notes

- Upgrading from `0.1.0` is `npm update`. There are no API changes in the three
  core packages; this release exists to publish the scaffolder alongside them.
- `0.1.1` was tagged in the repository and never published, so npm goes from
  `0.1.0` straight to `0.2.0`.

## [0.1.1] - 2026-08-10

Tagged, never published. No code differences from `0.1.0`. It was cut on a
mistaken reading of a `403 You cannot publish over the previously published
versions: 0.1.0`, which means the version was already published rather than that
it needed replacing.

## [0.1.0] - 2026-08-10

First public release.

### Added

- **`@kelpie/schemas`** — the wire contract for `/v1` as Zod schemas. One definition of what the API sends and accepts, shared by the service, the UI, and any agent decoding a response. Depends on Zod and nothing else.
- **`@kelpie/server`** — the service as a library. Module runtime, typed event bus, entitlements, and the core CRM modules: people, companies, positions, notes, activities, deals, opportunities, partnerships, raises, hiring, plans, decisions, handbook, search, dashboard, forms, import and export, agent tasks, webhooks, integrations, auth, API keys, and workspace administration. Ships its own migrations and applies them per module at boot.
- **`@kelpie/server/testing`** — the harness the core suite uses: app factory, database helpers, workspace fixtures, and a typed request client, so a module's tests can use the same tools.
- **`@kelpie/ui`** — React 19 components, pages, typed API client, and the extension registry an assembly composes modules through. Talks to the same public API agents use.
- MCP over Streamable HTTP on the same service, exposing the REST surface as tools.
- A packaging check, `npm run verify:packaging`, that installs the built tarballs outside the workspace and exercises them. In-workspace resolution always succeeds, so nothing else catches a broken package.

### Notes

- Requires Node 24 or newer and Postgres.
- `react` and `react-dom` are peer dependencies of `@kelpie/ui`.
- The packages export their TypeScript source under a `kelpie-source` condition and their compiled JavaScript under the default one. Consumers get JavaScript; the condition exists so the repository can develop without a build step. It is not part of the public contract.

[0.4.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.4.1
[0.4.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.4.0
[0.3.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.3.1
[0.3.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.3.0
[0.2.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.2.0
[0.1.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.1
[0.1.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.0

# Changelog

All notable changes to `@kelpie/schemas`, `@kelpie/server`, `@kelpie/ui`, and `create-kelpie`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

The packages share one version and release together. An assembly pins core, and a mismatched pair has no meaning. `create-kelpie` writes a project pinning core at its own version, so it moves with them. A release note that names no package applies to all of them.

While the major version is `0`, a minor bump may break the API.

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

[0.3.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.3.0
[0.2.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.2.0
[0.1.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.1
[0.1.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.0

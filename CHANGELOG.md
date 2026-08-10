# Changelog

All notable changes to `@kelpie/schemas`, `@kelpie/server`, and `@kelpie/ui`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

The three packages share one version and release together. An assembly pins all three, and a mismatched pair has no meaning. A release note that names no package applies to all of them.

While the major version is `0`, a minor bump may break the API.

## [0.1.1] - 2026-08-10

The first release you can install. No code differences from 0.1.0.

`0.1.0` reached the registry and was then unpublished. npm reserves an
unpublished version permanently, so republishing it returns
`403 You cannot publish over the previously published versions: 0.1.0`,
and it will keep doing so. The version number is spent. Hence 0.1.1, and hence
the gap at the start of the version list on npm.

## [0.1.0] - 2026-08-10

Never installable. See 0.1.1.

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

[0.1.1]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.1
[0.1.0]: https://github.com/velvet-tiger/kelpie/releases/tag/v0.1.0

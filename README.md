# Kelpie

Open-source CRM that AI agents can operate. Every record, every pipeline, and every page of your company handbook is available over MCP and a REST API. Your agent reads the same data your team does, and takes action through the same surface.

People, companies, deals, hiring, partnerships, fundraising, opportunities, and a markdown handbook. Self-host for free (AGPL-3.0) or use the paid cloud. No bundled AI. You bring the agent.

## Get started

You do not need this repository. In an empty directory:

```bash
npm create kelpie@latest
```

Then:

```bash
cd kelpie
npm install
docker compose up --detach --wait
npm run dev
```

Open <http://localhost:5173/signup> and create your workspace. Skip `docker compose` if you already have a Postgres.

Migrations apply at boot. There is no separate setup step.

To skip prompts, pass flags directly:

```bash
npm create kelpie@latest -- my-crm --yes --no-docker --database-url postgres://user:pass@db:5432/kelpie
```

`npm create kelpie@latest -- --help` lists all flags.

### Set it up with an AI agent

Copy this prompt into Claude Code, Cursor, or Codex:

> Set up a new Kelpie CRM project. Run `npm create kelpie@latest -- my-crm --yes` in an empty directory, then `cd my-crm && npm install`. If there is a `docker-compose.yml`, run `docker compose up --detach --wait`. Run `npm run dev` and confirm it is healthy by hitting `http://localhost:5173/healthz`. Create an account by POSTing to `http://localhost:5173/v1/auth/signup` with a JSON body containing `email`, `name`, and `password` (12-character minimum). Report the result.

### Upgrade

```bash
npm update @kelpie/server @kelpie/ui
```

Read the [changelog](CHANGELOG.md) first. While the major version is `0`, a minor bump may break the API.

## Develop

To work on Kelpie itself, clone this repository.

```bash
make setup    # install deps, create .env, start Postgres
make dev      # API on :3000, UI on :5173 (picks free ports if busy)
make test     # run every suite
```

`make` on its own lists every target. See [docs/development.md](docs/development.md) for the package layout, module system, database conventions, and release process.

### Email

Set `EMAIL_PROVIDER=log` for local development. Invite and password-reset links print to the API log. For SMTP, set `EMAIL_PROVIDER=smtp` and fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` in `.env.local`.

### Configuration

Every required variable stops the service at boot with a clear error if missing. See [`.env.example`](.env.example) for the full list with comments, or [docs/development.md](docs/development.md) for how `.env` and `.env.local` interact.

## Extend

Kelpie extends through a module system. Routes, MCP tools, database tables, and UI slots all register through it. Core uses the same system, so the extension points cannot rot.

The paid cloud assembles the same published packages with proprietary modules on top (billing, SSO, integrations). See [docs/extending/writing-a-module.md](docs/extending/writing-a-module.md) to build your own.

## Learn more

Full documentation: [docs/README.md](docs/README.md)

- [Getting started](docs/guides/getting-started.md) — using Kelpie, for your team
- [Installation](docs/self-hosting/installation.md) and [production](docs/self-hosting/production.md) — running your own
- [Connect an agent](docs/agents/connect-an-agent.md) — Claude, Cursor, or any MCP client
- [Writing a module](docs/extending/writing-a-module.md) — extending an install
- [docs/api-reference.md](docs/api-reference.md) — every endpoint
- [docs/development.md](docs/development.md) — packages, modules, packaging, releasing
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributing and copyright assignment

## License

AGPL-3.0. See [LICENSE](LICENSE).

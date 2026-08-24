# Installation

From an empty directory to a signed-in workspace. You do not need to clone this repository: the scaffolder writes you a small project of your own, and Kelpie itself arrives from npm.

## Requirements

- Node.js 24 or newer.
- Postgres. If you have Docker, the scaffolder writes a `docker-compose.yml` that runs one for you; if you already run Postgres, skip Docker and pass your connection string.

## Scaffold a project

```bash
npm create kelpie@latest
```

The prompts pick a directory, ports, and whether to include the Postgres compose file. To skip the prompts:

```bash
npm create kelpie@latest -- my-crm --yes
```

Useful flags (`npm create kelpie@latest -- --help` lists them all):

| Flag | Meaning |
| --- | --- |
| `--yes` / `-y` | Accept every default. Required when there is no terminal to prompt on. |
| `--no-docker` | Skip the compose file; you bring your own Postgres. |
| `--database-url <url>` | Your Postgres connection string. |
| `--port`, `--web-port`, `--database-port` | The API, dev-UI, and Postgres ports. |
| `--email-from <address>` | The from address for transactional mail. |

What you get is an **assembly**: a `package.json` pinning `@kelpie/server` and `@kelpie/ui` at the scaffolder's own version, the two module lists (`kelpie.config.ts`, `kelpie.ui.config.ts`), the entry points, a `.env` with a freshly generated `SECRET_ENCRYPTION_KEY`, and a README. These files are yours to edit and commit; Kelpie itself stays in `node_modules`. The scaffolder refuses a non-empty directory rather than writing into one.

## Start it

```bash
cd my-crm
npm install
docker compose up --detach --wait   # skip if you brought your own Postgres
npm run dev
```

The API listens on `PORT` and the dev UI on `WEB_PORT`; the UI proxies API calls, so the browser talks to one address. Migrations apply at boot — there is no separate setup step.

Confirm it is up:

```bash
curl -s http://localhost:5173/healthz
```

Expected: `{"status":"ok","database":"up"}`. A `"status":"degraded"` body means Postgres is not reachable.

## Create the first account

Open `http://localhost:5173/signup`. Passwords need at least 12 characters. Signup verifies your email address, then names your workspace, offers sample data, invites your team, and lands you in the app with a starter handbook in place.

Out of the box `EMAIL_PROVIDER=log`, so the verification link (and every invitation and password reset) is written to the API's log instead of sent. Watch the `npm run dev` output and copy the link from there.

## Sending real email

Set `EMAIL_PROVIDER=smtp` in `.env` and fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASSWORD`. The built-in `smtp-email` module sends the mail; nothing to install. A third-party provider module (Resend, Postmark, and the like) registers its own provider name instead — install it, add it to `kelpie.config.ts`'s `modules:`, and set `EMAIL_PROVIDER` to that name. Details: [Configuration](configuration.md#email).

## Set it up with an AI agent

Paste this into Claude Code, Cursor, or Codex and let it do the steps above:

> Set up a new Kelpie CRM project. Run `npm create kelpie@latest -- my-crm --yes` in an empty directory, then `cd my-crm && npm install`. If there is a `docker-compose.yml`, run `docker compose up --detach --wait`. Run `npm run dev` and confirm it is healthy by hitting `http://localhost:5173/healthz`. Create an account by POSTing to `http://localhost:5173/v1/auth/signup` with a JSON body containing `email`, `name`, and `password` (12-character minimum). Report the result.

## Next steps

- [Configuration](configuration.md) — every variable, including the ones production needs.
- [Production](production.md) — TLS, migrations, backups, upgrades.
- [Connect an agent](../agents/connect-an-agent.md) — point Claude or Cursor at your workspace.
- [Getting started](../guides/getting-started.md) — the product itself, for your team.

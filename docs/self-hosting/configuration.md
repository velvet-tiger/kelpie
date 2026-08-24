# Configuration

Every setting a self-hosted Kelpie reads, in one place. The short version lives in your scaffolded project's own README; this page is the full reference, including the settings a production deployment needs that the short version leaves out.

## How configuration works

`kelpie.config.ts` in your project is the source of truth. Each leaf marked `fromEnv('NAME', schema)` reads the named environment variable; anything written as a literal is fixed until you change the code. That is a feature: a value you never want an environment to override — a forced `BLOCK_PRIVATE_EGRESS`, a pinned log level — becomes a literal, and no stray variable can change it.

A missing or invalid required value stops the service at boot with a message listing every problem at once. Nothing defaults silently.

## Environment files

A scaffolded project reads one file: `.env`, loaded by every script through `--env-file-if-exists`. A variable already set in the shell beats it, which is how a deployment injects real values without editing the file. If `.env` is missing, the service does not crash on the flag; it stops at boot with a configuration error listing the variables it needed. Commit nothing secret: `.gitignore` already excludes `.env`.

## Core

| Variable | Required | Meaning |
| --- | --- | --- |
| `NODE_ENV` | yes | `development`, `test`, or `production`. |
| `PORT` | yes | The API's listen port. Bound exactly; boot fails if it is taken. |
| `API_PORT` | dev only | The same number again, read by the Vite dev server's proxy. Not read by the API. |
| `WEB_PORT` | dev only | The Vite dev server's port. Defaults to 5173. |
| `DATABASE_URL` | yes | A `postgres://` or `postgresql://` connection string. |
| `APP_BASE_URL` | yes | The address people reach this Kelpie on. Every emailed link — verification, password reset, invitation — is built from it, so a deployment must set its real public origin. |
| `LOG_LEVEL` | yes | `debug`, `info`, `warn`, or `error`. One JSON line per log call. |
| `WEB_BUNDLE_DIR` | production | The built web bundle to serve from the API process. Unset in development, where Vite serves the pages. See [Production](production.md). |

## Email

| Variable | Required | Meaning |
| --- | --- | --- |
| `EMAIL_PROVIDER` | yes | Which transactional-mail sender to use. `log` (built in) writes messages to the API log instead of sending — copy invitation and reset links from there during development. `smtp` sends through the built-in `smtp-email` module. A third-party provider module registers its own name. |
| `EMAIL_FROM` | yes | The from address for all transactional mail. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | when `smtp` | The mail server and its credentials. |
| `SMTP_SECURE` | when `smtp` | `true` connects over TLS from the start (typically port 465). `false` upgrades with STARTTLS (typically 587 or 25). |

## Secrets

| Variable | Required | Meaning |
| --- | --- | --- |
| `SECRET_ENCRYPTION_KEY` | yes | 32 bytes of base64. Seals the secrets Kelpie must read back: webhook signing keys and agent-task auth headers. The scaffolder generates one per project. |
| `SECRET_ENCRYPTION_KEY_PREVIOUS` | rotation only | The key being rotated away from. Set it during a rotation and remove it after `npm run reseal`. Procedure: [Production](production.md#rotating-the-encryption-key). |

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Back this key up alongside your database. A restored database without it cannot open any sealed secret.

## Rate limits

Four fixed-window budgets. Each takes a `_LIMIT` and a `_WINDOW_SECONDS` pair; all are optional, with the defaults shown. Over budget answers `429` with a `Retry-After` header.

| Budget | Guards | Counted per | Default |
| --- | --- | --- | --- |
| `RATE_LIMIT_FORMS_*` | Public form submit and embed | Client IP | 20 / 60 s |
| `RATE_LIMIT_AUTH_*` | Signup, login, password reset | Client IP | 10 / 60 s |
| `RATE_LIMIT_LOGIN_ACCOUNT_*` | Login, as a second budget | Account email | 10 / 900 s |
| `RATE_LIMIT_API_*` | Everything else on `/v1`, and `/mcp` | API key | 600 / 60 s |

The per-account login budget is the one an attacker rotating IP addresses cannot reset. Browser sessions carry no API budget; only bearer-key traffic is metered there.

## Behind a reverse proxy

| Variable | Required | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXY_HOP_COUNT` | behind a proxy | The number of reverse proxies in front of the service. `0` (the default) means direct access. Set the real hop count so the rate limiter reads the actual client IP from `X-Forwarded-For` instead of counting your proxy as the caller. |

## Outbound requests

| Variable | Required | Meaning |
| --- | --- | --- |
| `BLOCK_PRIVATE_EGRESS` | no | `true` refuses webhook deliveries and agent-task dispatches whose URL resolves to a private or reserved address. Default `false`, because a self-hosted install legitimately posts to internal hosts. Turn it on when strangers can register webhooks on your deployment. |

## Locking modules for the whole deployment

| Variable | Required | Meaning |
| --- | --- | --- |
| `KELPIE_MODULE_CONFIG_PATH` | no | Path to a JSON file that locks modules on or off for every workspace, ahead of each workspace's own Admin → Modules settings. |

The file names module ids:

```json
{ "modules": { "raises": false, "hiring": false } }
```

Naming a module the build does not have, or one that is structural (always on), fails boot. A locked module shows on the workspace settings screen greyed out rather than hidden, so an admin can see the choice exists and is not theirs to make.

## Naming the install

| Variable | Required | Meaning |
| --- | --- | --- |
| `KELPIE_SITE_NAME` | no | A label ("dev", "staging", "demo") shown in a strip at the top of the UI whenever `NODE_ENV` is not `production`, so two installs open side by side are easy to tell apart. Unset, the runtime mode is the label. Ignored in production. |

## Module settings

A module reads its own variables through its own schema, validated at boot like everything else. Two ship with core:

| Variable | Required | Meaning |
| --- | --- | --- |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | no | Days of webhook delivery log to keep. Default 30. |
| `BLOCK_PRIVATE_EGRESS` | no | Described above; read by the webhooks and agent-tasks modules. |

You can lock any module variable in code by adding an `env` section to `kelpie.config.ts`:

```ts
env: {
  BLOCK_PRIVATE_EGRESS: 'true',
}
```

A locked value wins over the environment, so a deployment cannot accidentally weaken it.

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
| `NODE_ENV` | yes | `development`, `test`, or `production`. A deployment sets `production`; in `development` the session cookie has no `Secure` flag. |
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
| `EMAIL_PROVIDER` | yes | Which transactional-mail sender to use. `log` (built in) writes messages to the API log instead of sending — copy invitation and reset links from there during development. Each log line has the sender, the recipient, the subject and the full plaintext `body`, and, when the message sets them, `fromName`, `replyTo` and `headers`. The HTML part is not printed; `htmlLength` gives its length. When `NODE_ENV` is `production` the line has `bodyLength` in place of `body`, and the service logs a warning at boot: see `EMAIL_LOG_BODY`. `smtp` sends through the built-in `smtp-email` module. A third-party provider module registers its own name. |
| `EMAIL_FROM` | yes | The sender of all transactional mail. One address, `kelpie@example.com`, or a name and one address, `Kelpie <kelpie@example.com>`. Put a name that has a comma in quotation marks: `"Acme, Inc." <kelpie@example.com>`. Any other text stops boot with an error that names the variable. |
| `EMAIL_LOG_BODY` | no | Whether the `log` provider writes the plaintext `body`, which holds the invitation and password-reset links. Unset, it does when `NODE_ENV` is `development` or `test`, and does not when it is `production`. `true` or `false` decides in every mode. Set `true` in production only when you run with no mail on purpose: everybody who can read the log can then use a link to sign in. Any other value stops boot. |
| `SMTP_HOST`, `SMTP_PORT` | when `smtp` | The mail server to connect to. |
| `SMTP_SECURE` | when `smtp` | `true` connects over TLS from the start (typically port 465). `false` starts in plain text and upgrades with STARTTLS (typically 587 or 25). The upgrade is required: see `SMTP_REQUIRE_TLS`. The server certificate is checked in both cases. |
| `SMTP_REQUIRE_TLS` | no | Applies when `SMTP_SECURE=false`. Unset, a server that does not offer STARTTLS fails the send, so the SMTP password and the mail never go in plain text. A server on the same machine (`localhost`, a `.localhost` name, a loopback address) is exempt, so a local catch-all needs no TLS. `false` permits plain text to every host: use it only for a relay on a private network that you trust, and the service logs a warning at boot. `true` applies the rule to a server on the same machine too. Any other value stops boot. |
| `SMTP_USER`, `SMTP_PASSWORD` | when the relay requires SMTP AUTH | The credentials. Optional and paired: set both to authenticate, or omit both to connect without SMTP AUTH (for local catch-alls like maildev, MailHog, smtp4dev). Setting exactly one fails at boot. |
| `FORMS_SPAM_MIN_SECONDS` | no | The shortest time a person takes to fill in a form, in seconds. Default `2`. On a form that requires the spam check, a submit that arrives sooner after its page loaded is held as spam. `0` turns this one rule off. |
| `CAPTCHA_PROVIDER` | no | The name of a CAPTCHA provider that one of your modules registers. Unset, no form shows a CAPTCHA. Kelpie ships no provider, so a name here with no module that registers it stops boot. |
| `FORMS_AUTO_REPLY_DAILY_LIMIT` | no | The most form auto-replies one workspace sends in a UTC day. Default `500`. An auto-reply goes to an address a visitor typed, so this limit stops a bot from using a public form to send a lot of mail from your server. Above it, auto-replies are skipped and the submission says why. |
| `FORMS_EXTERNAL_NOTIFICATION_DAILY_LIMIT` | no | The most form notifications one workspace sends in a UTC day to addresses that are not a member's. Default `500`. A member can put any address on a form as a recipient, so this limit stops a form from being used to send a lot of mail to strangers from your server. Above it, those messages are skipped and the submission says why. Notifications to members of the workspace have no limit. |

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

Five fixed-window budgets. Each takes a `_LIMIT` and a `_WINDOW_SECONDS` pair; all are optional, with the defaults shown. Over budget answers `429` with a `Retry-After` header.

| Budget | Guards | Counted per | Default |
| --- | --- | --- | --- |
| `RATE_LIMIT_FORMS_*` | Public form submit and embed together. The form's spam-check token, on a count of its own | Client IP | 20 / 60 s |
| `RATE_LIMIT_AUTH_*` | Signup, login, password reset | Client IP | 10 / 60 s |
| `RATE_LIMIT_LOGIN_ACCOUNT_*` | Login, as a second budget | Account email | 10 / 900 s |
| | Password reset requests for one address | Email address | 10 / 900 s |
| | Current-password checks, when a signed-in person changes their password or email | Account | 10 / 900 s |
| | Requests to send the verification mail again | Account, and the address mailed | 10 / 900 s |
| `RATE_LIMIT_API_*` | Everything else on `/v1`, and `/mcp` | API key or OAuth grant | 600 / 60 s |
| `RATE_LIMIT_OAUTH_*` | The OAuth endpoints MCP clients sign in through (`/oauth/*`) | Client IP | 60 / 60 s |

The per-account login budget is the one an attacker rotating IP addresses cannot reset. The same numbers set three more counts, each with its own counter. The reset count and the verification count stop one mailbox from being sent mail without limit. Over the reset count, the request answers `429` whether or not an account has the address.

An IPv6 client is counted by its `/64` prefix, not by its full address. An IPv4 client is counted by its address.

Browser sessions carry no API budget; only bearer-key traffic is metered there.

## Behind a reverse proxy

| Variable | Required | Meaning |
| --- | --- | --- |
| `TRUSTED_PROXY_HOP_COUNT` | behind a proxy | The number of reverse proxies in front of the service. `0` (the default) means direct access. Set the real hop count so the rate limiter reads the actual client IP from `X-Forwarded-For` instead of counting your proxy as the caller. |

## Outbound requests

| Variable | Required | Meaning |
| --- | --- | --- |
| `BLOCK_PRIVATE_EGRESS` | no | `true` refuses webhook deliveries, agent-task dispatches and OAuth client metadata fetches whose URL resolves to a private or reserved address. Only a global unicast address is accepted. Default `false`, because a self-hosted install legitimately posts to internal hosts. Turn it on when strangers can register webhooks on your deployment. |

## AI module

Read by the optional `ai` module, and only when `kelpie.config.ts` lists `createAiModule()`. Every variable is optional: each workspace admin can enter their own key in **Admin → AI**. See [The AI module](../agents/kelpie-ai.md).

| Variable | Required | Meaning |
| --- | --- | --- |
| `AI_PROVIDER` | no | `openai` or `anthropic`. The provider of the fallback key. |
| `AI_API_KEY` | no | A fallback key for every workspace that has not entered its own. Ignored without `AI_PROVIDER`, and never lent to the other provider. |
| `AI_MODEL` | no | The fallback model for `AI_PROVIDER`. Default `gpt-5.6-luna` (OpenAI) or `claude-opus-5` (Anthropic). |
| `AI_MAX_TOKENS` | no | The output cap per model call, 1024 to 128000. Default `16000`. |
| `AI_MAX_CONCURRENT_RUNS` | no | Runs at once per workspace, 1 to 20. Default `2`. More runs queue. |
| `AI_RUN_TIMEOUT_MINUTES` | no | A run still going after this long is marked failed on the next dispatch. Default `15`. |
| `AI_WORKER_CONCURRENCY` | no | Runs one worker process executes at once, across every workspace, 1 to 50. Default `4`. Runs execute on the job worker, so with `--no-worker` on the API they execute only in `npm run worker`. |
| `AI_RUN_LOG_LIMIT` | no | How many runs each workspace keeps in its run log. Default `100`. A workspace's `ai_settings.run_log_limit` overrides it. Runs from the current month are always kept, because the monthly run limit counts them. |

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
| `KELPIE_SITE_NAME` | no | A label ("dev", "staging", "demo", "cloud") shown in a coloured strip at the top of the UI whenever `NODE_ENV` is not `production`, so two installs open side by side are easy to tell apart. Known names each have a fixed colour; other names still pick one from the same set. Unset, the runtime mode is the label. Ignored in production. |

## Module settings

A module reads its own variables through its own schema, validated at boot like everything else. These ship with core:

| Variable | Required | Meaning |
| --- | --- | --- |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | no | Days of webhook delivery log to keep. Default 30. |
| `WEBHOOK_MAX_PER_WORKSPACE` | no | The most webhooks one workspace can register. Default 20. A workspace that already has more keeps them, and cannot add one until it is under the limit. |
| `WEBHOOK_MAX_CONCURRENT_DELIVERIES` | no | The most webhook deliveries the process runs at one time. Default 20. One delivery holds its place from the first attempt to the last retry. |
| `WEBHOOK_MAX_WAITING_DELIVERIES` | no | The most deliveries that wait for a place. Default 1000. A delivery over this limit is not sent. The delivery log shows it as failed with 0 attempts, and the server log has the `warn` line `webhook delivery not attempted`. `0` refuses a delivery whenever every place is in use. |
| `BLOCK_PRIVATE_EGRESS` | no | Described above; read by the webhooks and agent-tasks modules. |

You can lock any module variable in code by adding an `env` section to `kelpie.config.ts`:

```ts
env: {
  BLOCK_PRIVATE_EGRESS: 'true',
}
```

A locked value wins over the environment, so a deployment cannot accidentally weaken it.

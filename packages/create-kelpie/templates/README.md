# __PROJECT_NAME__

A self-hosted [Kelpie](https://github.com/velvet-tiger/kelpie) install.

These files are yours. Kelpie itself arrives as `@kelpie/server` and
`@kelpie/ui` in `node_modules`; what is checked in here is the assembly that
composes them: which modules are on, and how the service starts.

## Running it

```bash
npm install
```

Then start Postgres, if you took the `docker-compose.yml`:

```bash
docker compose up --detach --wait
```

Then:

```bash
npm run dev
```

The API listens on the `PORT` in `.env` and the UI on `WEB_PORT`. The UI proxies
API calls, so your browser only talks to one address.

Confirm it is up:

```bash
curl -s http://localhost:__WEB_PORT__/healthz
```

You should see `{"status":"ok","database":"up"}`. A `"status":"degraded"`
response means Postgres is not reachable.

Then open <http://localhost:__WEB_PORT__/signup> and create an account.
Passwords need at least 12 characters. Signup names your workspace, invites your
team, and leaves you on People with a starter handbook in place.

This default configuration doesn't send email. `EMAIL_PROVIDER=log` prints
invitation and password-reset links to the API's log instead of mailing them;
copy them from there to follow either flow. Set `EMAIL_PROVIDER=smtp` below to
send them for real.

## Adding a module

`kelpie.config.ts` is the server module list and `kelpie.ui.config.ts` is the UI
one. Install a module, add it to the relevant array, restart. Boot fails loudly
on an unknown id or an unmet dependency rather than starting without it.

## Configuration

Everything below is required unless marked optional or conditional on another
variable's value. A missing or invalid value stops the service at boot and
lists every problem at once.

| Variable | Values |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production` |
| `PORT` | The API's listen port. Bound exactly; the service fails if it is taken |
| `API_PORT` | The same number again, for the dev server's proxy |
| `WEB_PORT` | The Vite dev server's port. Development only |
| `DATABASE_URL` | A `postgres://` or `postgresql://` connection string |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| `EMAIL_PROVIDER` | `log` or `smtp`. `log` writes invitations and resets to the log instead of sending them |
| `EMAIL_FROM` | The address transactional mail comes from |
| `SMTP_HOST` | Required when `EMAIL_PROVIDER=smtp`. The mail server to connect to |
| `SMTP_PORT` | Required when `EMAIL_PROVIDER=smtp`. The mail server's port |
| `SMTP_SECURE` | Required when `EMAIL_PROVIDER=smtp`. `true` or `false`. Whether to connect over TLS from the start (typically port 465) rather than upgrading with STARTTLS (typically port 587 or 25) |
| `SMTP_USER` | Required when `EMAIL_PROVIDER=smtp`. The SMTP username |
| `SMTP_PASSWORD` | Required when `EMAIL_PROVIDER=smtp`. The SMTP password |
| `SECRET_ENCRYPTION_KEY` | 32 bytes of base64, generated for this project |
| `SECRET_ENCRYPTION_KEY_PREVIOUS` | Optional. Set only while rotating the key above |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | Optional, default 30 |
| `WEB_BUNDLE_DIR` | Optional. A built web bundle to serve from the same origin as the API. Unset while developing; see Deploying below |
| `RATE_LIMIT_FORMS_LIMIT` / `RATE_LIMIT_FORMS_WINDOW_SECONDS` | Optional. Requests per window per IP on a public form submit, default 20 / 60 |
| `RATE_LIMIT_AUTH_LIMIT` / `RATE_LIMIT_AUTH_WINDOW_SECONDS` | Optional. Requests per window per IP on signup, login, and password reset, default 10 / 60 |
| `RATE_LIMIT_API_LIMIT` / `RATE_LIMIT_API_WINDOW_SECONDS` | Optional. Requests per window per API key on the rest of `/v1`, default 600 / 60 |

### Rotating the encryption key

Replacing `SECRET_ENCRYPTION_KEY` makes every secret sealed under the old one
unreadable, so rotate rather than replace:

1. Move the current key to `SECRET_ENCRYPTION_KEY_PREVIOUS` and put a new one in
   `SECRET_ENCRYPTION_KEY`.
2. Deploy. New secrets seal under the new key; existing ones still read with the
   previous one.
3. Re-encrypt everything still under the old key. Safe to run more than once.
4. Remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and deploy again.

## Deploying

`npm run dev` runs two processes. Vite builds the pages as you edit them and
passes API calls through to the service, so your browser talks to one address.
Vite is a development tool and has no part in a deployment.

Build the pages once, then point the service at what it wrote:

```bash
npm run build
WEB_BUNDLE_DIR=./dist npm start
```

One process now serves the pages and the API on `PORT`. Boot fails if
`WEB_BUNDLE_DIR` holds no `index.html`, so a deployment whose build did not run
stops rather than answering every browser with a blank page.

Migrations apply at boot. Running more than one instance makes that a race, so
migrate once in a release step and start the instances with `--no-migrate`.

## Upgrading

```bash
npm update @kelpie/server @kelpie/ui
```

Migrations apply at boot. Read the
[changelog](https://github.com/velvet-tiger/kelpie/blob/main/CHANGELOG.md)
first: while the major version is `0`, a minor bump may break the API.

## License

Kelpie is AGPL-3.0. Running a modified version as a network service obliges you
to offer its source to your users. These assembly files are yours; the
obligation attaches to Kelpie itself.

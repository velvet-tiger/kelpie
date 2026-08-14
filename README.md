# Kelpie

Kelpie is an open-source CRM built for startups that work with AI agents. It
tracks every relationship a startup depends on: customers, partners,
opportunities, talent, and investors. It also doubles as a company brain: a
handbook of freeform notes that an agent can query alongside the structured
data.

Self-host it for free under AGPL-3.0, or use the paid cloud if you would
rather not run it yourself. Either way, the UI and any agent you connect use
the same public API. Kelpie ships no bundled AI: it exposes structured data
and an MCP server, and you bring the agent.

## What you get

- **People, Companies, and Positions** — who you know, where they work, and
  their title there. A person can hold positions at more than one company.
- **Deals and Opportunities** — a sales pipeline, plus non-sales chances like
  grants, accelerators, and speaking slots.
- **Partnerships and Raises** — ongoing two-way relationships, with a
  fundraising round tracked separately from the investor relationship itself.
- **Roles and Candidates** — a hiring pipeline kept off the Person record, so
  one person can be a candidate for one role while already hired through
  another.
- **Plans and Decisions** — dated action items and recorded commitments, both
  queryable so an agent does not act against them by mistake.
- **Notes and Activities** — attach to any record, and pin the ones an agent
  should read first.
- **Handbook** — nested markdown pages for product, voice, ICP, and anything
  else easier to write than to model as fields.
- **Forms** — embeddable inbound forms that create or update People,
  Companies, and Deals on submit.
- **Import and export** — CSV in and out, with a dry-run step before
  anything commits.
- **Agent tasks and MCP** — every record can hand an agent a ready-made
  prompt with the context it needs, and the same operations are available as
  MCP tools.
- **Webhooks** — notify another system when something changes.

## Requirements

To run Kelpie: Node 24 or newer, and a Postgres. Docker will do for the
Postgres, and the installer can write you a `docker-compose.yml`.

To work on Kelpie, add Docker and `make`.

## Install it

You do not need this repository to run Kelpie. In an empty directory:

```bash
npm create kelpie@latest
```

It asks four things, each with a default you can accept by pressing enter: the
directory to write into, whether you want a `docker-compose.yml` for Postgres,
your `DATABASE_URL`, and the address mail should come from.

What it writes is a small project of your own — two module lists, the entry
points, a Vite config, and a `.env` with an encryption key generated for you.
Kelpie itself arrives as `@kelpie/server` and `@kelpie/ui` in `node_modules`.
Those files are yours to edit and commit.

Then:

```bash
cd kelpie
npm install
docker compose up --detach --wait
npm run dev
```

Skip the `docker compose` line if you pointed `DATABASE_URL` at a database you
already have. Migrations apply at boot, so there is no separate setup step.

Open <http://localhost:5173/signup> and create an account. Passwords need at
least 12 characters. Signup names your workspace, invites your team, and leaves
you on People with a starter handbook in place.

To script it, every prompt is also a flag:

```bash
npm create kelpie@latest -- crm --yes --no-docker --database-url postgres://user:pass@db:5432/kelpie
```

`--yes` takes the defaults and never prompts, which is also required where there
is no terminal to prompt on. `npm create kelpie@latest -- --help` lists the rest.

### Upgrading

```bash
npm update @kelpie/server @kelpie/ui
```

Migrations apply at boot. Read the [changelog](CHANGELOG.md) first: while the
major version is `0`, a minor bump may break the API.

## Run it locally

This is the development workflow, for working on Kelpie itself: clone the
repository and run it from source.

Run these from the repository root, in order.

1. Install dependencies, create your environment file, and start Postgres.

   ```bash
   make setup
   ```

   This runs `npm install` and copies `.env.example` to `.env` with a
   generated `SECRET_ENCRYPTION_KEY`. It leaves an existing `.env` alone.
   Postgres starts on whatever host port Docker has free, so a second
   checkout will not collide with this one; `make` on its own lists every
   target.

2. Start the API and the UI together.

   ```bash
   make dev
   ```

   The API listens on port 3000 by default and the UI on 5173. The UI
   proxies API calls, so your browser only talks to one address. If either
   port is busy, the launcher picks a free one and prints what it chose.

3. Confirm it is running.

   ```bash
   curl -s http://localhost:5173/healthz
   ```

   You should see `{"status":"ok","database":"up"}`. A `"status":"degraded"`
   response means Postgres is not up yet: run `make up`, then restart
   `make dev`.

4. Open http://localhost:5173/signup and create an account. Passwords need
   at least 12 characters.

   Signup walks you through naming your workspace and inviting your team,
   then lands you on People with a starter handbook already in place.

   You can also create an account through the API, the way an agent or a
   seeding script would:

   ```bash
   curl -s -X POST http://localhost:5173/v1/auth/signup \
     -H 'Content-Type: application/json' \
     -d '{"email":"you@example.com","name":"Your Name","password":"a real long password"}'
   ```

5. This quickstart's default configuration doesn't send email.
   `EMAIL_PROVIDER=log` prints invitation and password-reset links to the
   API's log instead of mailing them; copy the link from there to follow
   either flow locally. Set `EMAIL_PROVIDER=smtp` below to send them for
   real.

## Configuration

Every variable below is required unless marked optional or conditional on
another variable's value. A missing or invalid value stops the service at
boot and lists every problem, rather than starting in a broken state.

| Variable | Values |
| --- | --- |
| `NODE_ENV` | `development`, `test`, or `production` |
| `PORT` | The API's listen port. The service binds this exact port and fails if it is taken; only the `make dev` launcher picks a free one for you |
| `DATABASE_URL` | A `postgres://` or `postgresql://` connection string |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| `EMAIL_PROVIDER` | `log` or `smtp`. `log` writes invites and password resets to the log instead of sending them |
| `EMAIL_FROM` | The address transactional mail comes from |
| `SMTP_HOST` | Required when `EMAIL_PROVIDER=smtp`. The mail server to connect to |
| `SMTP_PORT` | Required when `EMAIL_PROVIDER=smtp`. The mail server's port |
| `SMTP_SECURE` | Required when `EMAIL_PROVIDER=smtp`. `true` or `false`. Whether to connect over TLS from the start (typically port 465) rather than upgrading with STARTTLS (typically port 587 or 25) |
| `SMTP_USER` | Required when `EMAIL_PROVIDER=smtp`. The SMTP username |
| `SMTP_PASSWORD` | Required when `EMAIL_PROVIDER=smtp`. The SMTP password |
| `SECRET_ENCRYPTION_KEY` | 32 bytes of base64. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Seals secrets the service has to read back, such as webhook signing secrets |
| `SECRET_ENCRYPTION_KEY_PREVIOUS` | Optional. Set only while rotating the key above |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | Optional, default 30. How many days of webhook delivery history to keep |
| `WEB_BUNDLE_DIR` | Optional. Directory holding a built web bundle, served from the same origin as the API. Leave it unset in development, where the Vite dev server builds the pages and proxies the API. Set it in a deployment, after `npm run build`, and one process serves both. Boot fails if the directory holds no `index.html` |

`make setup` generates `SECRET_ENCRYPTION_KEY` for you. See
[`docs/development.md`](docs/development.md) for the rest of the variables
(`API_PORT`, `WEB_PORT`, and `TEST_DATABASE_URL`) and how `.env` and
`.env.local` interact.

### Rotating the encryption key

Changing `SECRET_ENCRYPTION_KEY` makes every secret sealed under the old one
unreadable, so rotate rather than replace it:

1. Move the current key to `SECRET_ENCRYPTION_KEY_PREVIOUS` and put a new one
   in `SECRET_ENCRYPTION_KEY`.
2. Deploy. New secrets seal under the new key; existing ones still read with
   the previous one.
3. Run `npm run reseal`. It re-encrypts every value still sealed under the
   old key, and is safe to run more than once.
4. Remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and deploy again.

## Everyday commands

| Command | Does |
| --- | --- |
| `make setup` | Installs dependencies, creates `.env` if it is missing, and starts the database |
| `make dev` | Starts the database if it is down, then the API and the UI |
| `make test` | Starts the database, then runs every test suite |
| `make up` / `make down` | Starts Postgres and writes `.env.local`, or stops it while keeping the data |
| `make reset` | Deletes the local database and starts an empty one. Asks first |
| `make psql` | Opens a `psql` shell on the development database |
| `make status` | Shows the database container's status |

Run `make` on its own for the full list.

## Self-hosted or cloud, and extending it

What you are looking at is the open-source core: AGPL-3.0, free to
self-host, no feature gates. A paid cloud version assembles the same
published packages with extra modules on top (billing, SSO, more
integrations).

Kelpie extends through a module system: routes, MCP tools, and
UI slots that core itself registers through. To build a module, see
[`docs/development.md`](docs/development.md).

Today, self-hosting means running from a clone with the steps above. The
scaffolder that will turn this into an install path of its own has not
shipped yet.

## Learn more

- [`docs/api-reference.md`](docs/api-reference.md) — every endpoint, and what
  is not built yet
- [`docs/development.md`](docs/development.md) — working on this repository:
  package layout, the module system, packaging, and releasing
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributing, and the copyright
  assignment every contribution includes

## License

AGPL-3.0, copyright the Kelpie project. See [`LICENSE`](LICENSE).

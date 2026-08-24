# Production

Running Kelpie for real: one Node process, a reverse proxy in front of it, Postgres behind it, and a handful of procedures worth doing properly — migrations, backups, upgrades, and key rotation.

## The shape of a deployment

In development, Vite serves the pages and proxies API calls. Vite is a development tool and has no part in a deployment. In production you build the pages once and the API process serves them itself, so one process answers everything on `PORT`.

## Build and serve

```bash
npm run build
WEB_BUNDLE_DIR=./dist npm start
```

Boot fails if `WEB_BUNDLE_DIR` holds no `index.html`, so a deployment whose build did not run stops with a clear error rather than answering every browser with a blank page. Deep links (`/people/per_…`) get the app shell; unknown `/v1` paths still get the API's JSON 404.

Set `APP_BASE_URL` to the real public origin (`https://crm.example.com`). Every emailed link is built from it; leave it on a localhost value and your invitations point at your laptop.

## Migrations

Migrations apply at boot, forward-only, and are safe to re-run. With one instance, that is the whole story.

Running more than one instance makes boot-time migration a race. Split it: run the migration once in a release step, then start the instances told not to migrate.

```bash
npm run migrate
npm start -- --no-migrate
```

## A reverse proxy with TLS

Terminate TLS in front of the service and proxy to `PORT`. Two worked examples — adapt the names, they are patterns rather than shipped files.

Caddy:

```
crm.example.com {
    reverse_proxy localhost:3000
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name crm.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Two settings must agree with the proxy:

- `TRUSTED_PROXY_HOP_COUNT=1` (or your real hop count). Without it the rate limiter reads your proxy's address as the client, and one busy proxy looks like one abusive caller.
- `APP_BASE_URL=https://crm.example.com`, as above.

## Keeping it running

Any supervisor works; the service is one process with no children. A minimal systemd unit as a pattern:

```ini
[Unit]
Description=Kelpie CRM
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/kelpie
EnvironmentFile=/srv/kelpie/.env
Environment=WEB_BUNDLE_DIR=/srv/kelpie/dist
ExecStart=/usr/bin/npm start -- --no-migrate
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Logs are one JSON line per event on stdout; point your collector at the journal or the process output and set `LOG_LEVEL` accordingly.

## Health checks

`GET /healthz` answers `{"status":"ok","database":"up"}`, and `"degraded"` with a 503 when the database probe fails. Wire it into your load balancer or orchestrator as both liveness and readiness; it takes no credentials.

## Containers

The compose files Kelpie ships run **Postgres only** — there is no application Dockerfile yet. If you containerise the app yourself, the pattern is the same as bare metal: `npm ci` and `npm run build` at image build time, `npm run migrate` as a release step, then the container runs the server with `WEB_BUNDLE_DIR` set and `--no-migrate`. The image needs no build tools at runtime, only Node 24.

## Backups and restore

Everything lives in Postgres, so the database dump is the backup:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=kelpie.backup
```

**Back up `SECRET_ENCRYPTION_KEY` with it.** Webhook signing secrets and agent auth headers are stored encrypted under that key; a restored database without the key holds sealed rows nothing can open, and there is no recovery path. Store the key wherever you store other secrets, not in the dump itself.

Restore is standard `pg_restore` into an empty database, then start the service pointed at it with the same key.

## Upgrading

```bash
npm update @kelpie/server @kelpie/ui
```

Read the [changelog](https://github.com/velvet-tiger/kelpie/blob/main/CHANGELOG.md) first: while the major version is `0`, a minor bump may break the API. Take a backup before upgrading — migrations are forward-only, so the way back from a bad upgrade is the backup, not a down migration. The new version's migrations apply on the next `npm run migrate` or boot.

## Rotating the encryption key

Replacing `SECRET_ENCRYPTION_KEY` outright makes every sealed secret unreadable, so rotate instead:

1. Move the current key to `SECRET_ENCRYPTION_KEY_PREVIOUS` and put a new key in `SECRET_ENCRYPTION_KEY`.
2. Deploy. New secrets seal under the new key; existing ones still open with the previous one.
3. Run `npm run reseal`. It rewrites every row still sealed under the old key, is safe to run more than once, and exits non-zero naming any row it could not open.
4. Remove `SECRET_ENCRYPTION_KEY_PREVIOUS` and deploy again.

## Operational caveats

Two subsystems run in-process with no durable queue, by design:

- **Webhook deliveries** retry three times over about twenty seconds. A crash mid-retry loses that delivery; the registration then reads `failing` and recovers on its own when an attempt lands. Receivers should treat deliveries as at-least-once and poll the API to reconcile anything critical.
- **Imports over 500 rows** run in the background. A restart mid-run strands the job in `validating` or `committing`; the remedy is to upload the file again, which is safe because commits are idempotent.

Neither needs routine attention; both are worth knowing before you read a log at 2 a.m.

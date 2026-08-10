# create-kelpie

Scaffolds a self-hosted [Kelpie](https://github.com/velvet-tiger/kelpie) install.

```bash
npm create kelpie@latest
```

Kelpie is an open-source, agent-native CRM and company brain. It is composed at
build time rather than shipped as a binary: an **assembly** is a small project
that lists its modules and boots the runtime. This writes you one.

There is nothing to clone. `@kelpie/server` and `@kelpie/ui` arrive as ordinary
dependencies, and the files this writes are yours to edit and commit.

## What it writes

```
package.json           @kelpie/server and @kelpie/ui, pinned to this version
kelpie.config.ts       the server module list
kelpie.ui.config.ts    the UI module list
src/server.ts          the entry point: config, modules, migrations, serve
web/index.html         the web entry
web/main.tsx
vite.config.ts         dev server, proxying /v1 to the API
tsconfig.server.json
tsconfig.web.json
.env                   with a SECRET_ENCRYPTION_KEY generated for this project
.gitignore
README.md              how to run it, and what every variable does
docker-compose.yml     Postgres, unless you said no
```

It writes files and stops. It does not run `npm install`, start Postgres, or
boot anything, so when something fails you are looking at your own terminal
rather than at output a scaffolder swallowed.

## Options

It prompts for what it cannot infer. Every answer is also a flag, so it runs
unattended:

```bash
npm create kelpie@latest crm -- --yes --database-url postgres://user:pass@db:5432/kelpie --no-docker
```

| Flag | Does |
| --- | --- |
| `--name <name>` | Package name. Defaults to the directory name |
| `--database-url <url>` | `postgres://` connection string |
| `--port <port>` | API port, default 3000 |
| `--web-port <port>` | Dev server port, default 5173 |
| `--database-port <port>` | Host port for the bundled Postgres, default 5432 |
| `--email-from <address>` | Address transactional mail comes from |
| `--docker`, `--no-docker` | Write a `docker-compose.yml` for Postgres |
| `--yes` | Take every default, never prompt |

Without a terminal to prompt on, `--yes` is required. A scaffolder that quietly
invents a database URL in CI writes a project that fails at boot, a long way
from the cause.

It refuses a directory that already contains anything.

## Versions

The generated manifest pins `@kelpie/server` and `@kelpie/ui` at this package's
own version, and the four release together. `create-kelpie@0.3.0` writes a
project asking for `@kelpie/server@^0.3.0`.

## Licence

AGPL-3.0-only.

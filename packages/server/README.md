# @kelpie/server

The [Kelpie](https://github.com/velvet-tiger/kelpie) service as a library.

Kelpie is an open-source, agent-native CRM and company brain. This package holds the module runtime, the core CRM modules, the REST API, the MCP surface, and the shared migration pipeline.

It is a library, not a program. Importing it starts nothing. You compose an **assembly**: a small app that lists its modules, wires its dependencies, and serves. That is what lets a self-hosted deployment and a commercial one run the same core with different module lists.

## Install

```bash
npm install @kelpie/server @hono/node-server
```

Needs Node 24 or newer and a Postgres it can reach through `DATABASE_URL`.

## Use

```ts
import { serve } from '@hono/node-server'
import { connectDatabase, createApp, createEventBus, createIdFactory, createLogger, loadConfig, registerModules, runMigrations } from '@kelpie/server'

import { modules } from './kelpie.config.ts'

const config = loadConfig(process.env)
const logger = createLogger(config.logLevel)
const database = connectDatabase(config.databaseUrl, logger)
const events = createEventBus(logger)

const contributions = await registerModules({ modules, environment: process.env, logger, events, /* … */ })

await runMigrations(database.db, contributions.schemas, logger)

const app = createApp({ logger, probeDatabase: database.probe, contributions, /* … */ })

serve({ fetch: app.fetch, port: config.port })
```

Registration runs before migrations. Modules declare their migrations directory while registering, so there is nothing to migrate until that pass has finished.

The full entry point, including shutdown and error handling, is [`apps/kelpie/src/server.ts`](https://github.com/velvet-tiger/kelpie/blob/main/apps/kelpie/src/server.ts). Start from that rather than from the sketch above.

## Migrations

The package ships its migrations. `coreMigrationsDirectory` points at them, and `runMigrations` applies them per module at boot. Nothing else has to be installed to get a working schema.

## Testing

`@kelpie/server/testing` exports the harness the core suite uses: an app factory, a database connection helper, workspace fixtures, and a typed request client. A module's own tests can use the same tools.

```ts
import { createTestApp, insertWorkspaceFixture } from '@kelpie/server/testing'
```

## Licence

AGPL-3.0-only. Running a modified version as a network service obliges you to offer its source to users.

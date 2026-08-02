import { fileURLToPath } from 'node:url'

import type { KelpieModule } from '../runtime/module.ts'
import * as activities from './activities/schema.ts'
import * as agentTasks from './agent-tasks/schema.ts'
import * as apiKeys from './api-keys/schema.ts'
import { createAuthModule } from './auth/index.ts'
import * as companies from './companies/schema.ts'
import * as deals from './deals/schema.ts'
import * as decisions from './decisions/schema.ts'
import * as forms from './forms/schema.ts'
import * as handbook from './handbook/schema.ts'
import * as hiring from './hiring/schema.ts'
import * as importExport from './import-export/schema.ts'
import * as integrations from './integrations/schema.ts'
import * as notes from './notes/schema.ts'
import * as opportunities from './opportunities/schema.ts'
import * as partnerships from './partnerships/schema.ts'
import * as people from './people/schema.ts'
import * as pipelines from './pipelines/schema.ts'
import * as plans from './plans/schema.ts'
import * as positions from './positions/schema.ts'
import * as raises from './raises/schema.ts'
import * as webhooks from './webhooks/schema.ts'
import * as workspace from './workspace/schema.ts'

/**
 * The core feature modules, in the order `architecture.md` fixes. Core registers
 * through the same runtime modules do; if core could not be built on these
 * extension points, neither could anything else.
 *
 * Order matters for `requires` resolution and route registration. Nothing else
 * about runtime behaviour may depend on it.
 *
 * Core shares one migrations directory. Drizzle Kit generates one ordered
 * pipeline from the barrel in `src/schema`, so splitting it per module would mean
 * one config per module for no gain. A module outside core brings its own.
 */
export const coreMigrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url))

interface CoreModuleDefinition {
  readonly id: string
  readonly requires?: readonly string[]
  readonly tables: Readonly<Record<string, unknown>>
}

const definitions: readonly CoreModuleDefinition[] = [
  { id: 'workspace', requires: ['auth'], tables: workspace },
  { id: 'api-keys', requires: ['workspace'], tables: apiKeys },
  { id: 'people', requires: ['workspace'], tables: people },
  { id: 'companies', requires: ['workspace'], tables: companies },
  { id: 'positions', requires: ['people', 'companies'], tables: positions },
  { id: 'pipelines', requires: ['workspace'], tables: pipelines },
  { id: 'deals', requires: ['companies', 'pipelines'], tables: deals },
  { id: 'opportunities', requires: ['pipelines'], tables: opportunities },
  { id: 'partnerships', requires: ['companies', 'pipelines'], tables: partnerships },
  { id: 'raises', requires: ['companies', 'pipelines'], tables: raises },
  { id: 'hiring', requires: ['people'], tables: hiring },
  { id: 'plans', requires: ['workspace'], tables: plans },
  { id: 'decisions', requires: ['workspace'], tables: decisions },
  { id: 'notes', requires: ['workspace'], tables: notes },
  { id: 'activities', requires: ['workspace'], tables: activities },
  { id: 'handbook', requires: ['workspace'], tables: handbook },
  { id: 'forms', requires: ['people', 'companies', 'positions', 'deals'], tables: forms },
  { id: 'import-export', requires: ['workspace'], tables: importExport },
  { id: 'agent-tasks', requires: ['workspace'], tables: agentTasks },
  { id: 'webhooks', requires: ['workspace'], tables: webhooks },
  { id: 'integrations', requires: ['workspace'], tables: integrations },
]

/**
 * Modules with behaviour are written out; the rest contribute only tables so far
 * and are generated from the table above. As each grows routes and services it
 * moves out of `definitions` into its own module file, like `auth` has.
 */
export const coreModules: readonly KelpieModule[] = [
  createAuthModule(coreMigrationsDirectory),
  ...definitions.map((definition): KelpieModule => ({
    id: definition.id,
    ...(definition.requires === undefined ? {} : { requires: definition.requires }),
    register(context) {
      context.schema(definition.tables, coreMigrationsDirectory)

      return Promise.resolve()
    },
  })),
]

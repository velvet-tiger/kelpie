import { fileURLToPath } from 'node:url'

import type { KelpieModule } from '../runtime/module.ts'
import { createActivitiesModule } from './activities/index.ts'
import * as agentTasks from './agent-tasks/schema.ts'
import { createApiKeysModule } from './api-keys/index.ts'
import { createAuthModule } from './auth/index.ts'
import { createCompaniesModule } from './companies/index.ts'
import { createDealsModule } from './deals/index.ts'
import { createDecisionsModule } from './decisions/index.ts'
import * as forms from './forms/schema.ts'
import * as handbook from './handbook/schema.ts'
import { createHiringModule } from './hiring/index.ts'
import * as importExport from './import-export/schema.ts'
import * as integrations from './integrations/schema.ts'
import { createNotesModule } from './notes/index.ts'
import { createOpportunitiesModule } from './opportunities/index.ts'
import { createPartnershipsModule } from './partnerships/index.ts'
import { createPeopleModule } from './people/index.ts'
import { createPipelinesModule } from './pipelines/index.ts'
import { createPlansModule } from './plans/index.ts'
import { createPositionsModule } from './positions/index.ts'
import { createRaisesModule } from './raises/index.ts'
import * as webhooks from './webhooks/schema.ts'
import { createWorkspaceModule } from './workspace/index.ts'

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
  createWorkspaceModule(coreMigrationsDirectory),
  createApiKeysModule(coreMigrationsDirectory),
  createPeopleModule(coreMigrationsDirectory),
  createCompaniesModule(coreMigrationsDirectory),
  createPositionsModule(coreMigrationsDirectory),
  createActivitiesModule(coreMigrationsDirectory),
  createNotesModule(coreMigrationsDirectory),
  createPipelinesModule(coreMigrationsDirectory),
  createDealsModule(coreMigrationsDirectory),
  createOpportunitiesModule(coreMigrationsDirectory),
  createPartnershipsModule(coreMigrationsDirectory),
  createRaisesModule(coreMigrationsDirectory),
  createHiringModule(coreMigrationsDirectory),
  createPlansModule(coreMigrationsDirectory),
  createDecisionsModule(coreMigrationsDirectory),
  ...definitions.map((definition): KelpieModule => ({
    id: definition.id,
    ...(definition.requires === undefined ? {} : { requires: definition.requires }),
    register(context) {
      context.schema(definition.tables, coreMigrationsDirectory)

      return Promise.resolve()
    },
  })),
]

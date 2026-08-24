import { fileURLToPath } from 'node:url'

import type { KelpieModule } from '../runtime/module.ts'
import { createActivitiesModule } from './activities/index.ts'
import { createAgentTasksModule } from './agent-tasks/index.ts'
import { createApiKeysModule } from './api-keys/index.ts'
import { createAuthModule } from './auth/index.ts'
import { createCompaniesModule } from './companies/index.ts'
import { createDashboardModule } from './dashboard/index.ts'
import { createDealsModule } from './deals/index.ts'
import { createDecisionsModule } from './decisions/index.ts'
import { createFormsModule } from './forms/index.ts'
import { createHandbookModule } from './handbook/index.ts'
import { createHiringModule } from './hiring/index.ts'
import { createImportExportModule } from './import-export/index.ts'
import { createListsModule } from './lists/index.ts'
import { createNotesModule } from './notes/index.ts'
import { createOpportunitiesModule } from './opportunities/index.ts'
import { createPartnershipsModule } from './partnerships/index.ts'
import { createPeopleModule } from './people/index.ts'
import { createPipelinesModule } from './pipelines/index.ts'
import { createPlansModule } from './plans/index.ts'
import { createPositionsModule } from './positions/index.ts'
import { createRaisesModule } from './raises/index.ts'
import { createSampleDataModule } from './sample-data/index.ts'
import { createSearchModule } from './search/index.ts'
import { createSmtpEmailModule } from './smtp-email/index.ts'
import { createWebhooksModule } from './webhooks/index.ts'
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
  createListsModule(coreMigrationsDirectory),
  createHandbookModule(coreMigrationsDirectory),
  // Neither of these takes a migrations directory: they own no tables and read
  // other modules'.
  createSearchModule(),
  createDashboardModule(),
  createFormsModule(coreMigrationsDirectory),
  createImportExportModule(coreMigrationsDirectory),
  createAgentTasksModule(coreMigrationsDirectory),
  createWebhooksModule(coreMigrationsDirectory),
  // Owns no tables. One-shot fixture install for a new workspace, called from
  // the setup wizard's checkbox and the admin data page.
  createSampleDataModule(),
  // Owns no tables. Registers a `'smtp'` provider with core's email runtime;
  // the factory only runs if the assembly's `email.provider` picks it.
  createSmtpEmailModule(),
]

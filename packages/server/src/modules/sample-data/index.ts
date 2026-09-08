import type { KelpieModule } from '../../runtime/module.ts'
import { mountSampleDataRoutes } from './routes.ts'
import { createSampleDataService } from './service.ts'
import { registerSampleDataTools } from './tools.ts'

/**
 * Sample data: fixture install for a workspace.
 *
 * Owns no tables. Requires the modules whose tables the fixture writes into.
 * A workspace admin invokes it from the setup wizard or from the admin data
 * page; an agent invokes it through the matching MCP tool. Existing records
 * stay. The installer skips fixture rows for a toggleable module the workspace
 * has switched off, and answers 409 when a sample email or domain already
 * exists.
 */
export function createSampleDataModule(): KelpieModule {
  return {
    id: 'sample-data',
    requires: [
      'workspace',
      'pipelines',
      'companies',
      'people',
      'positions',
      'deals',
      'plans',
      'notes',
      'opportunities',
      'raises',
      'partnerships',
      'enquiries',
      'hiring',
      'events',
    ],

    register(context) {
      const service = createSampleDataService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        entitlements: context.entitlements,
      })

      context.routes((router) => {
        mountSampleDataRoutes(router, { db: context.db, now: context.now, service })
      })

      registerSampleDataTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

export type { SampleDataCounts, SampleDataService } from './service.ts'

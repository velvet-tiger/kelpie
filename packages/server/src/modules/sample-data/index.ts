import type { KelpieModule } from '../../runtime/module.ts'
import { mountSampleDataRoutes } from './routes.ts'
import { createSampleDataService } from './service.ts'
import { registerSampleDataTools } from './tools.ts'

/**
 * Sample data: one-shot fixture install for a new workspace.
 *
 * Owns no tables. Requires the modules whose tables the fixture writes into.
 * A workspace admin invokes it from the setup wizard or from the admin data
 * page; an agent invokes it through the matching MCP tool.
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
    ],

    register(context) {
      const service = createSampleDataService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
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

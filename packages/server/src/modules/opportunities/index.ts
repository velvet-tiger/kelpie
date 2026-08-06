import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountOpportunitiesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createOpportunitiesService } from './service.ts'

/**
 * Opportunities: the non-sales pipeline.
 *
 * Requires its relations because creating one checks that the company, stage,
 * and owner are all in the caller's workspace before linking them, and
 * `activities` because every write leaves its timeline entry in the same
 * transaction.
 */
export function createOpportunitiesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'opportunities',
    requires: ['companies', 'pipelines', 'activities'],

    register(context) {
      const service = createOpportunitiesService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity: createActivityRecorder({
          createId: context.createId,
          now: context.now,
        }),
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountOpportunitiesRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

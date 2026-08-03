import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountDealsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createDealsService } from './service.ts'

/**
 * Deals: the sales pipeline.
 *
 * Requires its relations because creating one checks that the company, stage,
 * owner, and people are all in the caller's workspace before linking them, and
 * `activities` because every write leaves its timeline entry in the same
 * transaction.
 */
export function createDealsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'deals',
    requires: ['companies', 'people', 'pipelines', 'activities'],

    register(context) {
      const service = createDealsService({
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
      context.webhookEvents(['record.created', 'record.updated', 'record.deleted', 'stage.changed'])

      context.routes((router) => {
        mountDealsRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

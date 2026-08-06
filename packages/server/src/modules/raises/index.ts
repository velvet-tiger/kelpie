import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountRaisesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createRaisesService } from './service.ts'

/**
 * Raises: fundraising processes, one per firm per round.
 *
 * Requires its relations because creating one checks that the firm, stage,
 * owner, and key people are all in the caller's workspace before linking them,
 * and `activities` because every write leaves its timeline entry in the same
 * transaction.
 */
export function createRaisesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'raises',
    requires: ['companies', 'people', 'pipelines', 'activities'],

    register(context) {
      const service = createRaisesService({
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
        mountRaisesRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

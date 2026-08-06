import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountPartnershipsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPartnershipsService } from './service.ts'

/**
 * Partnerships: ongoing two-way relationships.
 *
 * Requires its relations because creating one checks that the company, stage,
 * owner, and key people are all in the caller's workspace before linking them,
 * and `activities` because every write leaves its timeline entry in the same
 * transaction.
 */
export function createPartnershipsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'partnerships',
    requires: ['companies', 'people', 'pipelines', 'activities'],

    register(context) {
      const service = createPartnershipsService({
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
        mountPartnershipsRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

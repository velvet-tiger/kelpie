import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountPeopleRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPeopleService } from './service.ts'

/**
 * People: who the workspace knows.
 *
 * Requires `workspace`: every person belongs to one, and the actor's workspace is
 * the only scope a request can reach.
 */
export function createPeopleModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'people',
    requires: ['workspace', 'activities'],

    register(context) {
      const service = createPeopleService({
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
        mountPeopleRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

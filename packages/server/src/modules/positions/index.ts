import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { positionsEvents } from './events.ts'
import { mountPositionsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPositionsService } from './service.ts'
import { registerPositionsTools } from './tools.ts'

/**
 * Position: the person-to-company link, and the only place a job title lives.
 *
 * Requires both ends, because creating one checks that the person and the company
 * are in the caller's workspace before linking them.
 */
export function createPositionsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'positions',
    requires: ['people', 'companies', 'activities'],
    events: positionsEvents,

    register(context) {
      const service = createPositionsService({
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
        mountPositionsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerPositionsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

import type { KelpieModule } from '../../runtime/module.ts'
import { decisionsEvents } from './events.ts'
import { mountDecisionsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createDecisionsService } from './service.ts'
import { registerDecisionsTools } from './tools.ts'

/**
 * Decisions: what the workspace decided or promised, on the record it is about
 * and on one workspace-wide list.
 *
 * No `activities` requirement: a decision write files no timeline entry,
 * because `ACTIVITY_KINDS` has no value that describes one (the plans
 * precedent).
 */
export function createDecisionsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'decisions',
    requires: ['workspace'],
    structural: true,
    events: decisionsEvents,

    register(context) {
      const service = createDecisionsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountDecisionsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerDecisionsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

import type { KelpieModule } from '../../runtime/module.ts'
import { plansEvents } from './events.ts'
import { mountPlansRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPlansService } from './service.ts'
import { registerPlansTools } from './tools.ts'

/**
 * Plan items: the dated next steps on the four pipelines.
 *
 * Requires `workspace` for the owner reference. It does not require
 * `activities`: a plan item writes no timeline entry, because `ACTIVITY_KINDS`
 * has no value that describes one.
 */
export function createPlansModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'plans',
    requires: ['workspace'],
    structural: true,
    events: plansEvents,

    register(context) {
      const service = createPlansService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountPlansRoutes(router, { db: context.db, now: context.now, service })
      })

      registerPlansTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

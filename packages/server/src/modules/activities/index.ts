import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from './recorder.ts'
import type { ActivityDraft, ActivityRecorder } from './recorder.ts'
import { mountActivitiesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createActivitiesService } from './service.ts'
import { registerActivitiesTools } from './tools.ts'

/**
 * Activities: the history every other module writes into.
 *
 * This module owns the table and the read side. The write side is the recorder,
 * which the emitting modules build for themselves from `context.createId` and
 * `context.now` inside their own `register`. It holds no state, so three
 * instances of it are three closures over the same two injectables, not three
 * copies of anything. The alternative was threading one instance through
 * `core.ts` into every module that emits, or a service locator, and neither is
 * worth avoiding a stateless factory call.
 */
export function createActivitiesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'activities',
    requires: ['workspace'],

    register(context) {
      const service = createActivitiesService({ db: context.db })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountActivitiesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerActivitiesTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

export { createActivityRecorder }
export type { ActivityDraft, ActivityRecorder }

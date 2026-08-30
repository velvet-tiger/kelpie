import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { peopleEvents } from './events.ts'
import { mountPeopleRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPeopleService } from './service.ts'
import { registerPeopleTools } from './tools.ts'

/**
 * People: who the workspace knows.
 *
 * Requires `workspace`: every person belongs to one, and the actor's workspace is
 * the only scope a request can reach.
 */
export function createPeopleModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'people',
    requires: ['workspace', 'activities', 'custom-fields'],
    structural: true,
    events: peopleEvents,

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
        customFields: createCustomFieldValues({ db: context.db }),
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountPeopleRoutes(router, { db: context.db, now: context.now, service })
      })

      registerPeopleTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

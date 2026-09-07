import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { createAttendancesService } from './attendances.ts'
import { crmEventsCatalog } from './catalog.ts'
import { mountEventsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createEventsService } from './service.ts'
import { registerEventsTools } from './tools.ts'

/**
 * Events: dated gatherings, attendances, and Event-only associations.
 *
 * Requires people (attendees), activities (timeline), and custom-fields
 * (workspace-defined attributes on the Event). Associations resolve other
 * modules' tables directly, the way notes resolve polymorphic targets.
 */
export function createEventsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'events',
    requires: ['people', 'activities', 'custom-fields'],
    events: crmEventsCatalog,

    register(context) {
      const recordActivity = createActivityRecorder({
        createId: context.createId,
        now: context.now,
      })
      const shared = {
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity,
      }

      context.schema(schema, migrationsDirectory)

      const events = createEventsService({
        ...shared,
        customFields: createCustomFieldValues({ db: context.db }),
      })
      const attendances = createAttendancesService(shared)

      context.routes((router) => {
        mountEventsRoutes(router, { db: context.db, now: context.now, events, attendances })
      })

      registerEventsTools(context.mcp, { events, attendances })

      return Promise.resolve()
    },
  }
}

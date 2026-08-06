import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountNotesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createNotesService } from './service.ts'
import { registerNotesTools } from './tools.ts'

/**
 * Notes: what a person wrote down about a record.
 *
 * Requires `activities`, because writing a note writes the timeline entry
 * announcing it, in the same transaction.
 */
export function createNotesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'notes',
    requires: ['workspace', 'activities'],

    register(context) {
      const service = createNotesService({
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
        mountNotesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerNotesTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

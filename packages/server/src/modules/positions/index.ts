import type { KelpieModule } from '../../runtime/module.ts'
import { mountPositionsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPositionsService } from './service.ts'

/**
 * Position: the person-to-company link, and the only place a job title lives.
 *
 * Requires both ends, because creating one checks that the person and the company
 * are in the caller's workspace before linking them.
 */
export function createPositionsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'positions',
    requires: ['people', 'companies'],

    register(context) {
      const service = createPositionsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)
      context.webhookEvents(['record.created', 'record.updated', 'record.deleted'])

      context.routes((router) => {
        mountPositionsRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

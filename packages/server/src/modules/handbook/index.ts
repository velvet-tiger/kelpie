import type { KelpieModule } from '../../runtime/module.ts'
import { mountHandbookRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createHandbookService } from './service.ts'

/**
 * The handbook: the workspace's own narrative, as nested markdown pages.
 *
 * Requires only `workspace`. A page attaches to nothing and nothing attaches to
 * a page: `RECORD_TARGET_TYPES` does not carry `handbook_page`, so there are no
 * notes, decisions, or timeline entries to keep in step, and no activity
 * recorder to take as a dependency.
 *
 * The starter pages a new workspace opens with are seeded by the workspace
 * module, in the same transaction that creates the workspace. They are rows a
 * team then edits, not fixtures this module owns.
 */
export function createHandbookModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'handbook',
    requires: ['workspace'],

    register(context) {
      const service = createHandbookService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)
      context.webhookEvents(['record.created', 'record.updated', 'record.deleted'])

      context.routes((router) => {
        mountHandbookRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

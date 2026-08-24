import type { KelpieModule } from '../../runtime/module.ts'
import { listsEvents } from './events.ts'
import { mountListsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createListsService } from './service.ts'
import { registerListsTools } from './tools.ts'

/**
 * Lists: named collections of records of one type.
 *
 * Requires `workspace` for the tenancy column. Every other record type is
 * addressed polymorphically through `target_type` + `target_id`, so this module
 * does not depend on the modules whose records it references.
 */
export function createListsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'lists',
    requires: ['workspace'],
    structural: true,
    events: listsEvents,

    register(context) {
      const service = createListsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountListsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerListsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

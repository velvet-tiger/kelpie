import type { KelpieModule } from '../../runtime/module.ts'
import { mountTagsRoutes } from './routes.ts'
import { createTagsService } from './service.ts'
import { registerTagsTools } from './tools.ts'

/**
 * The tags already in use, for a picker or an agent to reuse.
 *
 * It contributes no tables. A tag is a string in the `tags` array of the record
 * that carries it, and each of those columns belongs to its own module.
 * `requires` names every one of them, so an assembly that leaves one out fails
 * at boot rather than answering with a query against a missing table.
 *
 * `structural`: every tag field in the UI searches through it, so a workspace
 * that switched it off would be left with pickers that answer 404.
 */
export function createTagsModule(): KelpieModule {
  return {
    id: 'tags',
    requires: [
      'workspace',
      'people',
      'companies',
      'enquiries',
      'deals',
      'opportunities',
      'raises',
      'partnerships',
      'events',
      'forms',
    ],
    structural: true,

    register(context) {
      const service = createTagsService({ db: context.db })

      context.routes((router) => {
        mountTagsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerTagsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

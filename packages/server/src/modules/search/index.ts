import type { KelpieModule } from '../../runtime/module.ts'
import { mountSearchRoutes } from './routes.ts'
import { createSearchService } from './service.ts'
import { registerSearchTools } from './tools.ts'

/**
 * One box across nine collections.
 *
 * It contributes no tables and calls no `context.schema`. The `search_vector`
 * column each searchable table carries belongs to that table's own module, which
 * is the only place that knows which of its columns are worth indexing.
 *
 * `requires` names every module holding one of those columns, including the two
 * that are never results themselves: `positions` carries the job titles People are
 * found by, and `plans` the step titles Deals, Opportunities and Raises are found
 * by. Nothing here runs at registration, so this is not about ordering. It is
 * about an assembly built without one of them, which would boot and then answer
 * this endpoint with a query against a table that has no migration.
 *
 * `structural`, like `dashboard`: the search box is in the application shell on
 * every page, so a workspace that switched this off would be left with a control
 * that answers 404.
 */
export function createSearchModule(): KelpieModule {
  return {
    id: 'search',
    requires: [
      'workspace',
      'people',
      'positions',
      'companies',
      'deals',
      'opportunities',
      'partnerships',
      'raises',
      'hiring',
      'plans',
      'decisions',
      'handbook',
    ],
    structural: true,

    register(context) {
      const service = createSearchService({ db: context.db })

      context.routes((router) => {
        mountSearchRoutes(router, { db: context.db, now: context.now, service })
      })

      registerSearchTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

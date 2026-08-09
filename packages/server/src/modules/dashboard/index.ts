import type { KelpieModule } from '../../runtime/module.ts'
import { mountDashboardRoutes } from './routes.ts'
import { createDashboardService } from './service.ts'
import { registerDashboardTools } from './tools.ts'

/**
 * The workspace home: what is open, what is late, and what happened lately.
 *
 * It contributes no tables and calls no `context.schema`. Every row it reads
 * belongs to another module, and a dashboard that stored its own copy would be a
 * cache nothing invalidates.
 *
 * `requires` names each of those modules. Nothing here runs at registration, so
 * the dependency is not about ordering the `register` calls: it is about a build
 * that leaves one of them out. An assembly without `plans` would boot happily
 * and answer this endpoint with a query against a table that has no migration.
 */
export function createDashboardModule(): KelpieModule {
  return {
    id: 'dashboard',
    requires: [
      'workspace',
      'people',
      'pipelines',
      'deals',
      'opportunities',
      'raises',
      'partnerships',
      'plans',
      'decisions',
      'notes',
      'activities',
      'hiring',
    ],
    structural: true,

    register(context) {
      const service = createDashboardService({ db: context.db, now: context.now })

      context.routes((router) => {
        mountDashboardRoutes(router, { db: context.db, now: context.now, service })
      })

      registerDashboardTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

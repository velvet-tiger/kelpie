import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { companiesEvents } from './events.ts'
import { mountCompaniesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createCompaniesService } from './service.ts'
import { registerCompaniesTools } from './tools.ts'

/**
 * Companies: the organisations behind the people.
 *
 * Requires `workspace` only. People reach companies through Position, which is
 * its own module, so nothing here depends on `people`.
 */
export function createCompaniesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'companies',
    requires: ['workspace', 'activities', 'custom-fields'],
    structural: true,
    events: companiesEvents,

    register(context) {
      const service = createCompaniesService({
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
        mountCompaniesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerCompaniesTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

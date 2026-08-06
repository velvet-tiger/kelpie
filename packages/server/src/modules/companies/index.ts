import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountCompaniesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createCompaniesService } from './service.ts'

/**
 * Companies: the organisations behind the people.
 *
 * Requires `workspace` only. People reach companies through Position, which is
 * its own module, so nothing here depends on `people`.
 */
export function createCompaniesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'companies',
    requires: ['workspace', 'activities'],

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
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountCompaniesRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

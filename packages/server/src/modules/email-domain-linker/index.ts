import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountEmailDomainLinkerRoutes } from './routes.ts'
import { createEmailDomainLinkerService } from './service.ts'

/**
 * Rebuild every email-domain link across the workspace.
 *
 * Owns no tables. Requires the modules whose data the sweep reads and writes.
 * The sweep is the same one the companies service runs on a domain change,
 * applied to every workspace Company at once — used to backfill links for
 * data that predates the auto-linker, or after a bulk import.
 */
export function createEmailDomainLinkerModule(): KelpieModule {
  return {
    id: 'email-domain-linker',
    requires: ['workspace', 'companies', 'people', 'positions', 'activities'],

    register(context) {
      const service = createEmailDomainLinkerService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity: createActivityRecorder({
          createId: context.createId,
          now: context.now,
        }),
      })

      context.routes((router) => {
        mountEmailDomainLinkerRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

export type { EmailDomainLinkerService, RelinkCounts } from './service.ts'

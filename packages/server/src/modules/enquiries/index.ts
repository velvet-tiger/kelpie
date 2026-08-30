import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCustomFieldValues } from '../custom-fields/index.ts'
import { enquiriesEvents } from './events.ts'
import { mountEnquiriesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createEnquiriesService } from './service.ts'
import { registerEnquiriesTools } from './tools.ts'

/**
 * Enquiries: the top-of-funnel pipeline.
 *
 * Requires its relations because creating one checks that the company, stage,
 * and owner are all in the caller's workspace before linking them, and
 * `activities` because every write leaves its timeline entry in the same
 * transaction. `deals` is required for `convertToDeal`, which inserts into
 * the deals table directly (the standard cross-module write pattern, per
 * `architecture.md`).
 */
export function createEnquiriesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'enquiries',
    requires: ['companies', 'pipelines', 'activities', 'custom-fields', 'deals'],
    events: enquiriesEvents,

    register(context) {
      const service = createEnquiriesService({
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
        mountEnquiriesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerEnquiriesTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

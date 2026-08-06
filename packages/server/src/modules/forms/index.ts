import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountPublicFormRoutes } from './publicRoutes.ts'
import { mountFormsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createFormsService } from './service.ts'
import { createFormSubmitService } from './submission.ts'

/**
 * Forms: embeddable inbound capture, per `forms.md`.
 *
 * The only core module with a public surface. Managing forms needs credentials
 * like everything else; submitting one needs nothing but the form's `publicKey`,
 * because the caller is a stranger's browser on a stranger's website.
 *
 * It requires everything a submit writes. `people`, `companies` and `positions`
 * are the upsert; `deals` and `pipelines` are the optional deal and the stage it
 * opens in; `activities` is the timeline entry, in the same transaction as the
 * records it describes. `workspace` arrives through those.
 */
export function createFormsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'forms',
    requires: ['people', 'companies', 'positions', 'pipelines', 'deals', 'activities'],

    register(context) {
      const service = createFormsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      const submissions = createFormSubmitService({
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
        mountFormsRoutes(router, { db: context.db, now: context.now, service })
      })

      context.publicRoutes((router) => {
        mountPublicFormRoutes(router, { db: context.db, submissions })
      })

      return Promise.resolve()
    },
  }
}

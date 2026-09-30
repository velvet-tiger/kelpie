import { z } from 'zod'

import { appUrlConfigSchema } from '../../lib/appUrl.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { defineSendFormEmailsJob } from './emailJob.ts'
import { formsEvents } from './events.ts'
import { mountPublicFormRoutes } from './publicRoutes.ts'
import { mountFormsRoutes } from './routes.ts'
import * as repository from './repository.ts'
import * as schema from './schema.ts'
import { createFormsService } from './service.ts'
import { createFormSubmitService } from './submission.ts'
import { registerFormsTools } from './tools.ts'

/**
 * Deployment configuration the forms module reads. Every key is optional.
 *
 * `FORMS_AUTO_REPLY_DAILY_LIMIT` caps the auto-replies one workspace sends in
 * a UTC day. An auto-reply goes to an address an unauthenticated visitor
 * typed, so the cap protects the deployment's sending reputation from a bot
 * that fills in a public form with other people's addresses.
 */
export const formsConfigSchema = z.object({
  FORMS_AUTO_REPLY_DAILY_LIMIT: z.coerce.number().int().min(0).default(500),
})

/**
 * Forms: embeddable inbound capture.
 *
 * The only core module with a public surface. Managing forms needs credentials
 * like everything else; submitting one needs nothing but its workspace id and `slug`,
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
    requires: [
      'people',
      'companies',
      'positions',
      'pipelines',
      'deals',
      'opportunities',
      'partnerships',
      'raises',
      'lists',
      'activities',
    ],
    events: formsEvents,

    register(context) {
      const config = context.config(formsConfigSchema)
      const sendEmailsJob = context.jobs.define(
        defineSendFormEmailsJob({
          db: context.db,
          email: context.email,
          createId: context.createId,
          now: context.now,
          appBaseUrl: context.appBaseUrl ?? context.config(appUrlConfigSchema).APP_BASE_URL,
          entitlements: context.entitlements,
          autoReplyDailyLimit: config.FORMS_AUTO_REPLY_DAILY_LIMIT,
        }),
      )

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
        entitlements: context.entitlements,
        sendEmailsJob,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountFormsRoutes(router, { db: context.db, now: context.now, service })
      })

      context.publicRoutes((router) => {
        mountPublicFormRoutes(router, {
          db: context.db,
          submissions,
          entitlements: context.entitlements,
        })
      })

      registerFormsTools(context.mcp, service)

      // A deleted list leaves the "Add to list" fields that offered it. The
      // form-level `form_lists` rows go by foreign-key cascade; field lists
      // are a `text[]`, so they are cleaned here.
      context.events.subscribe('lists.list.deleted', async (event) => {
        await repository.removeListFromFields(context.db, event.workspaceId, event.target.id)
      })

      return Promise.resolve()
    },
  }
}

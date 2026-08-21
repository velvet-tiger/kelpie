import { z } from 'zod'

import { appUrlConfigSchema } from '../../lib/appUrl.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { mountAuthRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createAuthService } from './service.ts'

/**
 * Accounts, sessions, and password recovery.
 *
 * Registers before `workspace`, because `workspace_members.user_id` references
 * `users`.
 */

const nodeEnvSchema = z.object({
  /** Cookies go out `Secure` everywhere except development. */
  NODE_ENV: z.enum(['development', 'test', 'production']),
})

export function createAuthModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'auth',
    structural: true,

    register(context) {
      const { NODE_ENV } = context.config(nodeEnvSchema)
      // Prefer the top-level `appBaseUrl` from the assembly's kelpie.config.ts;
      // fall back to the schema read for older assemblies that don't declare it.
      const appBaseUrl = context.appBaseUrl ?? context.config(appUrlConfigSchema).APP_BASE_URL

      const service = createAuthService({
        db: context.db,
        transaction: context.transaction,
        email: context.email,
        createId: context.createId,
        now: context.now,
        appBaseUrl,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountAuthRoutes(router, {
          db: context.db,
          now: context.now,
          service,
          // `Secure` everywhere except development. A test host reaches the API
          // over http through a test client, which stores the cookie regardless
          // of the flag, so test is not excluded.
          cookie: { secure: NODE_ENV !== 'development' },
        })
      })

      return Promise.resolve()
    },
  }
}

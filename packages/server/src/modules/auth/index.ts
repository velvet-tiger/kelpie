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

const authConfigSchema = z
  .object({
    /** Cookies go out `Secure` everywhere except development. */
    NODE_ENV: z.enum(['development', 'test', 'production']),
  })
  .merge(appUrlConfigSchema)

export function createAuthModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'auth',
    structural: true,

    register(context) {
      const config = context.config(authConfigSchema)
      const service = createAuthService({
        db: context.db,
        transaction: context.transaction,
        email: context.email,
        createId: context.createId,
        now: context.now,
        appBaseUrl: config.APP_BASE_URL,
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
          cookie: { secure: config.NODE_ENV !== 'development' },
        })
      })

      return Promise.resolve()
    },
  }
}

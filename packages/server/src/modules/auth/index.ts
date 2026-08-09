import { z } from 'zod'

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

const authConfigSchema = z.object({
  /** Cookies go out `Secure` everywhere except development. */
  NODE_ENV: z.enum(['development', 'test', 'production']),
})

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
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountAuthRoutes(router, {
          db: context.db,
          now: context.now,
          service,
          cookie: { secure: config.NODE_ENV === 'production' },
        })
      })

      return Promise.resolve()
    },
  }
}

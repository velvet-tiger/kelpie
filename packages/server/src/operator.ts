import { Hono } from 'hono'

import { requireSessionActor } from './lib/actor.ts'
import { AppError } from './lib/errors.ts'
import { resolveActorFrom } from './modules/auth/credentials.ts'
import type { CredentialDependencies } from './modules/auth/credentials.ts'
import * as authRepository from './modules/auth/repository.ts'
import type { ModuleRouter } from './runtime/registry.ts'

/**
 * The operator surface: deployment-level support tooling, mounted by
 * `createApp` at `OPERATOR_ROUTE_PREFIX` the same way the MCP transport is
 * mounted at `/mcp`.
 *
 * It is not part of `/v1` because operator access is a deployment concern,
 * not a workspace role. A workspace or personal API key is refused outright:
 * a key is bound to one workspace and carries that workspace's authority,
 * which is exactly the credential this surface must not answer to. The only
 * way in is a browser session belonging to an account named in
 * `SUPERUSER_EMAILS`.
 *
 * Modules contribute the routes (`ModuleContext.operatorRoutes`); core ships
 * the guard and the mount and no routes of its own. The guard runs ahead of
 * every contribution, so a contributed handler only ever sees a superuser's
 * request.
 */

export const OPERATOR_ROUTE_PREFIX = '/operator/api'

export interface OperatorDependencies {
  readonly credentials: CredentialDependencies
  /** Lower-cased operator emails from `SUPERUSER_EMAILS`. Empty means nobody. */
  readonly superuserEmails: ReadonlySet<string>
  readonly routers: readonly ModuleRouter[]
}

/**
 * Three checks, in order:
 *
 * 1. A credential must be present and valid (401 otherwise).
 * 2. It must be a session, not an API key (403 otherwise).
 * 3. The session's account email must be on the allowlist (403 otherwise).
 *
 * The email is read from the database on every request rather than trusted
 * from anywhere else: a session carries only a user id, and re-reading means
 * an email change takes effect on the next request, not the next sign-in.
 */
export function createOperatorRouter(dependencies: OperatorDependencies): Hono {
  const router = new Hono()

  router.use('*', async (context, next) => {
    const actor = requireSessionActor(await resolveActorFrom(dependencies.credentials, context))
    const user = await authRepository.findUserById(dependencies.credentials.db, actor.userId)

    if (user === undefined || !dependencies.superuserEmails.has(user.email.toLowerCase())) {
      throw new AppError('forbidden', 'This account is not on the operator allowlist')
    }

    await next()
  })

  for (const contribution of dependencies.routers) {
    router.route('/', contribution.router)
  }

  return router
}

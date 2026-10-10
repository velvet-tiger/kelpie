import type { MiddlewareHandler } from 'hono'

import { isBearerActor } from '../../lib/actor.ts'
import {
  isScopedCredential,
  isScopeExemptRoute,
  requireApiKeyScope,
  resolveRestScope,
} from '../../lib/apiKeyScopes.ts'
import type { RouteScopeRule } from '../../lib/apiKeyScopes.ts'
import { AppError } from '../../lib/errors.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { readBearerToken } from './keys.ts'

/**
 * Blocks API-key requests that lack the scope a route needs. Sessions pass
 * through unchanged.
 *
 * A route with no rule is refused to a scoped key. A full-access key and a
 * session reach it as before. `moduleRules` are the rules that modules
 * declared for their own routes.
 */
export function createApiKeyScopeMiddleware(
  dependencies: CredentialDependencies,
  moduleRules: readonly RouteScopeRule[] = [],
): MiddlewareHandler {
  return async (context, next) => {
    // The router answers a HEAD with the GET handler, so a HEAD needs what the
    // GET needs. Read as its own method it would match no rule.
    const method = context.req.method === 'HEAD' ? 'GET' : context.req.method
    const path = context.req.path

    if (isScopeExemptRoute(method, path)) {
      await next()
      return
    }

    const required = resolveRestScope(method, path, moduleRules)

    if (required !== null) {
      const actor = await resolveActorFrom(dependencies, context)

      if (isBearerActor(actor)) {
        requireApiKeyScope(actor, required)
      }

      await next()
      return
    }

    // No rule. Only a bearer credential can be scoped, so a request without
    // one goes on, and the route decides about the session or its absence.
    if (readBearerToken(context.req.header('Authorization')) === undefined) {
      await next()
      return
    }

    if (isScopedCredential(await resolveActorFrom(dependencies, context))) {
      throw new AppError(
        'forbidden',
        'This API key is limited to its scopes, and no scope is declared for this route. Use a key with full access',
      )
    }

    await next()
  }
}

import type { MiddlewareHandler } from 'hono'

import { requireApiKeyScope, resolveRestScope } from '../../lib/apiKeyScopes.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'

/**
 * Blocks API-key requests that lack the scope a route needs. Sessions pass
 * through unchanged.
 */
export function createApiKeyScopeMiddleware(
  dependencies: CredentialDependencies,
): MiddlewareHandler {
  return async (context, next) => {
    const required = resolveRestScope(context.req.method, context.req.path)

    if (required === null) {
      await next()
      return
    }

    const actor = await resolveActorFrom(dependencies, context)

    if (actor.kind === 'api_key') {
      requireApiKeyScope(actor, required)
    }

    await next()
  }
}

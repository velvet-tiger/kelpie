import type { Context, Hono } from 'hono'

import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { EmailDomainLinkerService, RelinkCounts } from './service.ts'

/**
 * Wire shape for `POST /v1/workspaces/:id/relink-email-domains`.
 *
 * No request body. The response counts what the sweep did.
 */

export interface EmailDomainLinkerRoutesDependencies extends CredentialDependencies {
  readonly service: EmailDomainLinkerService
}

export function relinkResponse(counts: RelinkCounts): Record<string, unknown> {
  return {
    companies_scanned: counts.companiesScanned,
    positions_created: counts.positionsCreated,
  }
}

export function mountEmailDomainLinkerRoutes(
  router: Hono,
  dependencies: EmailDomainLinkerRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActorFrom(dependencies, context)

  router.post('/workspaces/:id/relink-email-domains', async (context) => {
    const counts = await dependencies.service.relink(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(relinkResponse(counts))
  })
}

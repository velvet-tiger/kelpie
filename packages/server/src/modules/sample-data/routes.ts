import type { Context, Hono } from 'hono'

import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { SampleDataCounts, SampleDataService } from './service.ts'

/**
 * Wire shape for `POST /v1/workspaces/:id/sample-data`.
 *
 * No request body: the installer takes no options today. Any option we add
 * later goes on the body, not the URL.
 */

export interface SampleDataRoutesDependencies extends CredentialDependencies {
  readonly service: SampleDataService
}

export function sampleDataResponse(counts: SampleDataCounts): Record<string, unknown> {
  return {
    companies: counts.companies,
    people: counts.people,
    positions: counts.positions,
    deals: counts.deals,
    plan_items: counts.planItems,
    notes: counts.notes,
    opportunities: counts.opportunities,
    raises: counts.raises,
    partnerships: counts.partnerships,
    roles: counts.roles,
    candidates: counts.candidates,
  }
}

export function mountSampleDataRoutes(
  router: Hono,
  dependencies: SampleDataRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.post('/workspaces/:id/sample-data', async (context) => {
    const counts = await dependencies.service.install(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(sampleDataResponse(counts), 201)
  })
}

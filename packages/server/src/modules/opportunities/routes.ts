import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { isoDateSchema } from '../../lib/dates.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type {
  CreateOpportunityInput,
  OpportunitiesService,
  OpportunityView,
  UpdateOpportunityInput,
} from './service.ts'

/** Wire shapes for `/v1/opportunities`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const opportunityShape = {
  name: z.string().min(1),
  kind: z.string(),
  stage_id: z.string().min(1),
  company_id: z.string().min(1).nullable(),
  owner_id: z.string().min(1).nullable(),
  expected_close: isoDateSchema.nullable(),
  person_ids: z.array(z.string().min(1)),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
}

/**
 * Only `name` is required: an opportunity need not belong to a company. An
 * absent `stage_id` lands in the pipeline's first open stage and an absent
 * `owner_id` goes to the caller, both resolved in the service. `kind` defaults
 * to empty rather than to the mockup's invented "Other"; an unclassified
 * opportunity should read as unclassified.
 */
export const createBody = z.strictObject({
  ...opportunityShape,
  kind: opportunityShape.kind.default(''),
  stage_id: opportunityShape.stage_id.optional(),
  company_id: opportunityShape.company_id.default(null),
  owner_id: opportunityShape.owner_id.optional(),
  expected_close: opportunityShape.expected_close.default(null),
  person_ids: opportunityShape.person_ids.default([]),
  summary: opportunityShape.summary.default(''),
  tags: opportunityShape.tags.default([]),
})

export const updateBody = z.strictObject(opportunityShape).partial()

export interface OpportunitiesRoutesDependencies extends CredentialDependencies {
  readonly service: OpportunitiesService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateOpportunityInput {
  return {
    name: body.name,
    kind: body.kind,
    stageId: body.stage_id,
    companyId: body.company_id,
    ownerId: body.owner_id,
    expectedClose: body.expected_close,
    personIds: body.person_ids,
    summary: body.summary,
    tags: body.tags,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateOpportunityInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.kind === undefined ? {} : { kind: body.kind }),
    ...(body.stage_id === undefined ? {} : { stageId: body.stage_id }),
    ...(body.company_id === undefined ? {} : { companyId: body.company_id }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.expected_close === undefined ? {} : { expectedClose: body.expected_close }),
    ...(body.person_ids === undefined ? {} : { personIds: body.person_ids }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
  }
}

export function opportunityResponse(opportunity: OpportunityView): Record<string, unknown> {
  return {
    id: opportunity.id,
    name: opportunity.name,
    kind: opportunity.kind,
    stage_id: opportunity.stageId,
    company_id: opportunity.companyId,
    owner_id: opportunity.ownerId,
    expected_close: opportunity.expectedClose,
    person_ids: opportunity.personIds,
    summary: opportunity.summary,
    tags: opportunity.tags,
    created_at: opportunity.createdAt.toISOString(),
    updated_at: opportunity.updatedAt.toISOString(),
  }
}

export function mountOpportunitiesRoutes(
  router: Hono,
  dependencies: OpportunitiesRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/opportunities', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        kinds: readIdFilter(context, 'kind'),
        companyIds: readIdFilter(context, 'company_id'),
        stageIds: readIdFilter(context, 'stage_id'),
        personIds: readIdFilter(context, 'person_id'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, opportunityResponse))
  })

  router.post('/opportunities', async (context) => {
    const body = await readJsonBody(context, createBody)
    const opportunity = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )

    return context.json(opportunityResponse(opportunity), 201)
  })

  router.get('/opportunities/:id', async (context) => {
    const opportunity = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(opportunityResponse(opportunity))
  })

  router.patch('/opportunities/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const opportunity = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(opportunityResponse(opportunity))
  })

  router.delete('/opportunities/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

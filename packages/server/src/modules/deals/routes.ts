import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { isoDateSchema } from '../../lib/dates.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { CreateDealInput, DealView, DealsService, UpdateDealInput } from './service.ts'

/** Wire shapes for `/v1/deals`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const dealShape = {
  name: z.string().min(1),
  company_id: z.string().min(1),
  stage_id: z.string().min(1),
  value_cents: z.number().int().min(0).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u, 'Use a three-letter ISO 4217 code').nullable(),
  owner_id: z.string().min(1).nullable(),
  expected_close: isoDateSchema.nullable(),
  person_ids: z.array(z.string().min(1)),
  competitors: z.array(z.string().min(1)),
  risks: z.string(),
  why_win: z.string(),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  external_id: z.string().min(1).nullable(),
}

/**
 * Only `name` and `company_id` are required. An absent `stage_id` lands in the
 * pipeline's first open stage and an absent `owner_id` goes to the caller, both
 * resolved in the service; the value defaults here say "unknown", not zero, so
 * that a board of new deals does not read as a board of worthless ones.
 */
const createBody = z.strictObject({
  ...dealShape,
  stage_id: dealShape.stage_id.optional(),
  value_cents: dealShape.value_cents.default(null),
  currency: dealShape.currency.default('USD'),
  owner_id: dealShape.owner_id.optional(),
  expected_close: dealShape.expected_close.default(null),
  person_ids: dealShape.person_ids.default([]),
  competitors: dealShape.competitors.default([]),
  risks: dealShape.risks.default(''),
  why_win: dealShape.why_win.default(''),
  summary: dealShape.summary.default(''),
  tags: dealShape.tags.default([]),
  external_id: dealShape.external_id.default(null),
})

const updateBody = z.strictObject(dealShape).partial()

export interface DealsRoutesDependencies extends CredentialDependencies {
  readonly service: DealsService
}

function toCreateInput(body: z.infer<typeof createBody>): CreateDealInput {
  return {
    name: body.name,
    companyId: body.company_id,
    stageId: body.stage_id,
    valueCents: body.value_cents,
    currency: body.currency,
    ownerId: body.owner_id,
    expectedClose: body.expected_close,
    personIds: body.person_ids,
    competitors: body.competitors,
    risks: body.risks,
    whyWin: body.why_win,
    summary: body.summary,
    tags: body.tags,
    externalId: body.external_id,
  }
}

function toUpdateInput(body: z.infer<typeof updateBody>): UpdateDealInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.company_id === undefined ? {} : { companyId: body.company_id }),
    ...(body.stage_id === undefined ? {} : { stageId: body.stage_id }),
    ...(body.value_cents === undefined ? {} : { valueCents: body.value_cents }),
    ...(body.currency === undefined ? {} : { currency: body.currency }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.expected_close === undefined ? {} : { expectedClose: body.expected_close }),
    ...(body.person_ids === undefined ? {} : { personIds: body.person_ids }),
    ...(body.competitors === undefined ? {} : { competitors: body.competitors }),
    ...(body.risks === undefined ? {} : { risks: body.risks }),
    ...(body.why_win === undefined ? {} : { whyWin: body.why_win }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.external_id === undefined ? {} : { externalId: body.external_id }),
  }
}

export function dealResponse(deal: DealView): Record<string, unknown> {
  return {
    id: deal.id,
    name: deal.name,
    company_id: deal.companyId,
    stage_id: deal.stageId,
    value_cents: deal.valueCents,
    currency: deal.currency,
    owner_id: deal.ownerId,
    expected_close: deal.expectedClose,
    person_ids: deal.personIds,
    competitors: deal.competitors,
    risks: deal.risks,
    why_win: deal.whyWin,
    summary: deal.summary,
    tags: deal.tags,
    external_id: deal.externalId,
    created_at: deal.createdAt.toISOString(),
    updated_at: deal.updatedAt.toISOString(),
  }
}

export function mountDealsRoutes(router: Hono, dependencies: DealsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/deals', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        companyIds: readIdFilter(context, 'company_id'),
        stageIds: readIdFilter(context, 'stage_id'),
        personIds: readIdFilter(context, 'person_id'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, dealResponse))
  })

  router.post('/deals', async (context) => {
    const body = await readJsonBody(context, createBody)
    const deal = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(dealResponse(deal), 201)
  })

  router.get('/deals/:id', async (context) => {
    const deal = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(dealResponse(deal))
  })

  router.patch('/deals/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const deal = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(dealResponse(deal))
  })

  router.delete('/deals/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

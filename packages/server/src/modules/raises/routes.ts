import { customFieldsPatchShape } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { isoDateSchema } from '../../lib/dates.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { renderCustomFieldsForWire } from '../custom-fields/wire.ts'
import type { CreateRaiseInput, RaiseView, RaisesService, UpdateRaiseInput } from './service.ts'

/** Wire shapes for `/v1/raises`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const raiseShape = {
  name: z.string().min(1),
  company_id: z.string().min(1),
  stage_id: z.string().min(1),
  check_size_cents: z.number().int().min(0).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u, 'Use a three-letter ISO 4217 code').nullable(),
  thesis_fit: z.string(),
  // Empty would be a second spelling of "none" beside null on a nullable
  // column, the rule set for decision rationale.
  pass_reason: z.string().min(1).nullable(),
  owner_id: z.string().min(1).nullable(),
  expected_close: isoDateSchema.nullable(),
  person_ids: z.array(z.string().min(1)),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  custom_fields: customFieldsPatchShape,
}

/**
 * Only `name` and `company_id` are required: a raise is a process with a firm.
 * An absent `stage_id` lands in the pipeline's first open stage and an absent
 * `owner_id` goes to the caller, both resolved in the service. Check size and
 * target close default to null rather than the mockup's invented values; a
 * fabricated number is worse than an absent one for agents. Currency defaults
 * to USD like a deal's, so a check size set later already has a unit.
 */
export const createBody = z.strictObject({
  ...raiseShape,
  stage_id: raiseShape.stage_id.optional(),
  check_size_cents: raiseShape.check_size_cents.default(null),
  currency: raiseShape.currency.default('USD'),
  thesis_fit: raiseShape.thesis_fit.default(''),
  pass_reason: raiseShape.pass_reason.default(null),
  owner_id: raiseShape.owner_id.optional(),
  expected_close: raiseShape.expected_close.default(null),
  person_ids: raiseShape.person_ids.default([]),
  summary: raiseShape.summary.default(''),
  tags: raiseShape.tags.default([]),
  custom_fields: raiseShape.custom_fields.default({}),
})

export const updateBody = z.strictObject(raiseShape).partial()

export interface RaisesRoutesDependencies extends CredentialDependencies {
  readonly service: RaisesService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateRaiseInput {
  return {
    name: body.name,
    companyId: body.company_id,
    stageId: body.stage_id,
    checkSizeCents: body.check_size_cents,
    currency: body.currency,
    thesisFit: body.thesis_fit,
    passReason: body.pass_reason,
    ownerId: body.owner_id,
    expectedClose: body.expected_close,
    personIds: body.person_ids,
    summary: body.summary,
    tags: body.tags,
    customFields: body.custom_fields,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateRaiseInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.company_id === undefined ? {} : { companyId: body.company_id }),
    ...(body.stage_id === undefined ? {} : { stageId: body.stage_id }),
    ...(body.check_size_cents === undefined ? {} : { checkSizeCents: body.check_size_cents }),
    ...(body.currency === undefined ? {} : { currency: body.currency }),
    ...(body.thesis_fit === undefined ? {} : { thesisFit: body.thesis_fit }),
    ...(body.pass_reason === undefined ? {} : { passReason: body.pass_reason }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.expected_close === undefined ? {} : { expectedClose: body.expected_close }),
    ...(body.person_ids === undefined ? {} : { personIds: body.person_ids }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.custom_fields === undefined ? {} : { customFields: body.custom_fields }),
  }
}

export function raiseResponse(raise: RaiseView): Record<string, unknown> {
  return {
    id: raise.id,
    name: raise.name,
    company_id: raise.companyId,
    stage_id: raise.stageId,
    check_size_cents: raise.checkSizeCents,
    currency: raise.currency,
    thesis_fit: raise.thesisFit,
    pass_reason: raise.passReason,
    owner_id: raise.ownerId,
    expected_close: raise.expectedClose,
    person_ids: raise.personIds,
    summary: raise.summary,
    tags: raise.tags,
    custom_fields: renderCustomFieldsForWire(raise.customFields),
    created_at: raise.createdAt.toISOString(),
    updated_at: raise.updatedAt.toISOString(),
  }
}

export function mountRaisesRoutes(router: Hono, dependencies: RaisesRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/raises', async (context) => {
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

    return context.json(pageBody(page, raiseResponse))
  })

  router.post('/raises', async (context) => {
    const body = await readJsonBody(context, createBody)
    const raise = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(raiseResponse(raise), 201)
  })

  router.get('/raises/:id', async (context) => {
    const raise = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(raiseResponse(raise))
  })

  router.patch('/raises/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const raise = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(raiseResponse(raise))
  })

  router.delete('/raises/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

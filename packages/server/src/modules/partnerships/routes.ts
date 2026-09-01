import { convertPipelineRecordBody, convertedToResponse, customFieldsPatchShape } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { isoDateSchema } from '../../lib/dates.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { renderCustomFieldsForWire } from '../custom-fields/wire.ts'
import { mountPipelineConvertRoute } from '../conversions/routes.ts'
import type { ConversionsService } from '../conversions/index.ts'
import type {
  CreatePartnershipInput,
  PartnershipView,
  PartnershipsService,
  UpdatePartnershipInput,
} from './service.ts'

/** Wire shapes for `/v1/partnerships`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const partnershipShape = {
  name: z.string().min(1),
  company_id: z.string().min(1),
  stage_id: z.string().min(1),
  kind: z.string(),
  next_touchpoint: isoDateSchema.nullable(),
  owner_id: z.string().min(1).nullable(),
  goals: z.string(),
  success_looks_like: z.string(),
  person_ids: z.array(z.string().min(1)),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  custom_fields: customFieldsPatchShape,
}

/**
 * Only `name` and `company_id` are required: a partnership is with an
 * organisation. An absent `stage_id` lands in the pipeline's first open stage
 * and an absent `owner_id` goes to the caller, both resolved in the service.
 * `kind` and `next_touchpoint` default to empty and null rather than the
 * mockup's invented "Other" and today; a fabricated value is worse than an
 * absent one for agents.
 */
export const createBody = z.strictObject({
  ...partnershipShape,
  stage_id: partnershipShape.stage_id.optional(),
  kind: partnershipShape.kind.default(''),
  next_touchpoint: partnershipShape.next_touchpoint.default(null),
  owner_id: partnershipShape.owner_id.optional(),
  goals: partnershipShape.goals.default(''),
  success_looks_like: partnershipShape.success_looks_like.default(''),
  person_ids: partnershipShape.person_ids.default([]),
  summary: partnershipShape.summary.default(''),
  tags: partnershipShape.tags.default([]),
  custom_fields: partnershipShape.custom_fields.default({}),
})

export const updateBody = z.strictObject(partnershipShape).partial()

export interface PartnershipsRoutesDependencies extends CredentialDependencies {
  readonly service: PartnershipsService
  readonly conversions: ConversionsService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreatePartnershipInput {
  return {
    name: body.name,
    companyId: body.company_id,
    stageId: body.stage_id,
    kind: body.kind,
    nextTouchpoint: body.next_touchpoint,
    ownerId: body.owner_id,
    goals: body.goals,
    successLooksLike: body.success_looks_like,
    personIds: body.person_ids,
    summary: body.summary,
    tags: body.tags,
    customFields: body.custom_fields,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdatePartnershipInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.company_id === undefined ? {} : { companyId: body.company_id }),
    ...(body.stage_id === undefined ? {} : { stageId: body.stage_id }),
    ...(body.kind === undefined ? {} : { kind: body.kind }),
    ...(body.next_touchpoint === undefined ? {} : { nextTouchpoint: body.next_touchpoint }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.goals === undefined ? {} : { goals: body.goals }),
    ...(body.success_looks_like === undefined
      ? {}
      : { successLooksLike: body.success_looks_like }),
    ...(body.person_ids === undefined ? {} : { personIds: body.person_ids }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.custom_fields === undefined ? {} : { customFields: body.custom_fields }),
  }
}

export function partnershipResponse(partnership: PartnershipView): Record<string, unknown> {
  return {
    id: partnership.id,
    name: partnership.name,
    company_id: partnership.companyId,
    stage_id: partnership.stageId,
    kind: partnership.kind,
    next_touchpoint: partnership.nextTouchpoint,
    owner_id: partnership.ownerId,
    goals: partnership.goals,
    success_looks_like: partnership.successLooksLike,
    person_ids: partnership.personIds,
    summary: partnership.summary,
    tags: partnership.tags,
    converted_to: convertedToResponse(partnership.convertedTargetType, partnership.convertedTargetId),
    custom_fields: renderCustomFieldsForWire(partnership.customFields),
    created_at: partnership.createdAt.toISOString(),
    updated_at: partnership.updatedAt.toISOString(),
  }
}

export function mountPartnershipsRoutes(
  router: Hono,
  dependencies: PartnershipsRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/partnerships', async (context) => {
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

    return context.json(pageBody(page, partnershipResponse))
  })

  router.post('/partnerships', async (context) => {
    const body = await readJsonBody(context, createBody)
    const partnership = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )

    return context.json(partnershipResponse(partnership), 201)
  })

  router.get('/partnerships/:id', async (context) => {
    const partnership = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(partnershipResponse(partnership))
  })

  router.patch('/partnerships/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const partnership = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(partnershipResponse(partnership))
  })

  router.delete('/partnerships/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  mountPipelineConvertRoute(router, '/partnerships/:id/convert', {
    ...dependencies,
    sourceKind: 'partnership',
    bodySchema: convertPipelineRecordBody,
  })
}

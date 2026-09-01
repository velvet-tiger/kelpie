import { convertEnquiryBody, convertedToResponse, customFieldsPatchShape } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { renderCustomFieldsForWire } from '../custom-fields/wire.ts'
import { mountPipelineConvertRoute } from '../conversions/routes.ts'
import type { ConversionsService } from '../conversions/index.ts'
import type { CreateEnquiryInput, EnquiriesService, EnquiryView, UpdateEnquiryInput } from './service.ts'

/** Wire shapes for `/v1/enquiries`. Bodies are strict; an unknown field is a 422, per `api.md`. */

/**
 * The full field set, without defaults. `createBody` adds those; `updateBody`
 * makes it partial. `converted_deal_id` is read-only: it is set only by
 * `POST /v1/enquiries/:id/convert`, so it is not in this shape and any
 * `PATCH` that carries it is `422`.
 */
const enquiryShape = {
  name: z.string().min(1),
  source: z.string(),
  stage_id: z.string().min(1),
  company_id: z.string().min(1).nullable(),
  owner_id: z.string().min(1).nullable(),
  person_ids: z.array(z.string().min(1)),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  custom_fields: customFieldsPatchShape,
}

/**
 * Only `name` is required: an enquiry need not belong to a company. An absent
 * `stage_id` lands in the pipeline's first open stage and an absent
 * `owner_id` goes to the caller, both resolved in the service. `source`
 * defaults to empty; an unclassified enquiry should read as unclassified.
 */
export const createBody = z.strictObject({
  ...enquiryShape,
  source: enquiryShape.source.default(''),
  stage_id: enquiryShape.stage_id.optional(),
  company_id: enquiryShape.company_id.default(null),
  owner_id: enquiryShape.owner_id.optional(),
  person_ids: enquiryShape.person_ids.default([]),
  summary: enquiryShape.summary.default(''),
  tags: enquiryShape.tags.default([]),
  custom_fields: enquiryShape.custom_fields.default({}),
})

export const updateBody = z.strictObject(enquiryShape).partial()

export interface EnquiriesRoutesDependencies extends CredentialDependencies {
  readonly service: EnquiriesService
  readonly conversions: ConversionsService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateEnquiryInput {
  return {
    name: body.name,
    source: body.source,
    stageId: body.stage_id,
    companyId: body.company_id,
    ownerId: body.owner_id,
    personIds: body.person_ids,
    summary: body.summary,
    tags: body.tags,
    customFields: body.custom_fields,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateEnquiryInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.source === undefined ? {} : { source: body.source }),
    ...(body.stage_id === undefined ? {} : { stageId: body.stage_id }),
    ...(body.company_id === undefined ? {} : { companyId: body.company_id }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.person_ids === undefined ? {} : { personIds: body.person_ids }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.custom_fields === undefined ? {} : { customFields: body.custom_fields }),
  }
}

export function enquiryResponse(enquiry: EnquiryView): Record<string, unknown> {
  return {
    id: enquiry.id,
    name: enquiry.name,
    source: enquiry.source,
    stage_id: enquiry.stageId,
    company_id: enquiry.companyId,
    owner_id: enquiry.ownerId,
    converted_deal_id: enquiry.convertedDealId,
    converted_to: convertedToResponse(enquiry.convertedTargetType, enquiry.convertedTargetId),
    person_ids: enquiry.personIds,
    summary: enquiry.summary,
    tags: enquiry.tags,
    custom_fields: renderCustomFieldsForWire(enquiry.customFields),
    created_at: enquiry.createdAt.toISOString(),
    updated_at: enquiry.updatedAt.toISOString(),
  }
}

export function mountEnquiriesRoutes(
  router: Hono,
  dependencies: EnquiriesRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/enquiries', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        sources: readIdFilter(context, 'source'),
        companyIds: readIdFilter(context, 'company_id'),
        stageIds: readIdFilter(context, 'stage_id'),
        personIds: readIdFilter(context, 'person_id'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, enquiryResponse))
  })

  router.post('/enquiries', async (context) => {
    const body = await readJsonBody(context, createBody)
    const enquiry = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )

    return context.json(enquiryResponse(enquiry), 201)
  })

  router.get('/enquiries/:id', async (context) => {
    const enquiry = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(enquiryResponse(enquiry))
  })

  router.patch('/enquiries/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const enquiry = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(enquiryResponse(enquiry))
  })

  router.delete('/enquiries/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  /**
   * Convert an enquiry to another pipeline record type. An empty body defaults
   * the target to a deal for backward compatibility.
   */
  mountPipelineConvertRoute(router, '/enquiries/:id/convert', {
    ...dependencies,
    sourceKind: 'enquiry',
    bodySchema: convertEnquiryBody,
  })
}

import { CONSENT_PURPOSE_STATUSES } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type {
  ConsentPurposeView,
  ConsentPurposesService,
  CreateConsentPurposeInput,
  UpdateConsentPurposeInput,
} from './service.ts'

/**
 * Wire shapes for `/v1/consent_purposes`.
 *
 * `slug` is only on the create body: the update body omits it and the strict
 * PATCH answers `422` if it is sent. The description defaults to empty so a
 * write that only sets label + slug is accepted.
 */

export const createBody = z.strictObject({
  slug: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  default_status: z.enum(CONSENT_PURPOSE_STATUSES).default('unknown'),
})

export const updateBody = z
  .strictObject({
    label: z.string().min(1).max(120),
    description: z.string().max(2000),
    default_status: z.enum(CONSENT_PURPOSE_STATUSES),
    sort_order: z.number().int().min(0),
  })
  .partial()

export interface ConsentPurposesRoutesDependencies extends CredentialDependencies {
  readonly service: ConsentPurposesService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateConsentPurposeInput {
  return {
    slug: body.slug,
    label: body.label,
    description: body.description,
    defaultStatus: body.default_status,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateConsentPurposeInput {
  return {
    ...(body.label === undefined ? {} : { label: body.label }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.default_status === undefined ? {} : { defaultStatus: body.default_status }),
    ...(body.sort_order === undefined ? {} : { sortOrder: body.sort_order }),
  }
}

export function consentPurposeResponse(purpose: ConsentPurposeView): Record<string, unknown> {
  return {
    id: purpose.id,
    slug: purpose.slug,
    label: purpose.label,
    description: purpose.description,
    default_status: purpose.defaultStatus,
    sort_order: purpose.sortOrder,
    created_at: purpose.createdAt.toISOString(),
    updated_at: purpose.updatedAt.toISOString(),
  }
}

export function mountConsentPurposesRoutes(
  router: Hono,
  dependencies: ConsentPurposesRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActorFrom(dependencies, context)

  router.get('/consent_purposes', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      { term: context.req.query('q') },
      readListParameters(context),
    )
    return context.json(pageBody(page, consentPurposeResponse))
  })

  router.post('/consent_purposes', async (context) => {
    const body = await readJsonBody(context, createBody)
    const purpose = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )
    return context.json(consentPurposeResponse(purpose), 201)
  })

  router.get('/consent_purposes/:id', async (context) => {
    const purpose = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )
    return context.json(consentPurposeResponse(purpose))
  })

  router.patch('/consent_purposes/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const purpose = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )
    return context.json(consentPurposeResponse(purpose))
  })

  router.delete('/consent_purposes/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))
    return context.body(null, 204)
  })
}

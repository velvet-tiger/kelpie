import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { CUSTOM_FIELD_OBJECT_TYPES, CUSTOM_FIELD_TYPES } from './schema.ts'
import type { CustomFieldObjectType } from './schema.ts'
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinitionView,
  CustomFieldDefinitionsService,
  UpdateCustomFieldDefinitionInput,
} from './service.ts'

/**
 * Wire shapes for `/v1/custom_fields`.
 *
 * `key`, `type`, and `object_type` are only on the create body: the update
 * body omits them, and a strict PATCH answers `422` for any of the three.
 * `options` accepts any string list here; per-type membership (and the
 * "options only on select-like types" rule) live in the service.
 */

const optionsSchema = z.array(z.string().min(1).max(120)).max(100)

export const createBody = z.strictObject({
  object_type: z.enum(CUSTOM_FIELD_OBJECT_TYPES),
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: optionsSchema.default([]),
  description: z.string().max(2000).default(''),
})

export const updateBody = z
  .strictObject({
    label: z.string().min(1).max(120),
    description: z.string().max(2000),
    options: optionsSchema,
    sort_order: z.number().int().min(0),
  })
  .partial()

export interface CustomFieldsRoutesDependencies extends CredentialDependencies {
  readonly service: CustomFieldDefinitionsService
}

export function toCreateInput(
  body: z.infer<typeof createBody>,
): CreateCustomFieldDefinitionInput {
  return {
    objectType: body.object_type,
    key: body.key,
    label: body.label,
    type: body.type,
    options: body.options,
    description: body.description,
  }
}

export function toUpdateInput(
  body: z.infer<typeof updateBody>,
): UpdateCustomFieldDefinitionInput {
  return {
    ...(body.label === undefined ? {} : { label: body.label }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.options === undefined ? {} : { options: body.options }),
    ...(body.sort_order === undefined ? {} : { sortOrder: body.sort_order }),
  }
}

export function customFieldDefinitionResponse(
  definition: CustomFieldDefinitionView,
): Record<string, unknown> {
  return {
    id: definition.id,
    object_type: definition.objectType,
    key: definition.key,
    label: definition.label,
    type: definition.type,
    options: definition.options,
    description: definition.description,
    sort_order: definition.sortOrder,
    created_at: definition.createdAt.toISOString(),
    updated_at: definition.updatedAt.toISOString(),
  }
}

function readObjectTypeFilter(context: Context): CustomFieldObjectType | undefined {
  const raw = context.req.query('object_type')
  if (raw === undefined) {
    return undefined
  }
  if (!CUSTOM_FIELD_OBJECT_TYPES.includes(raw as CustomFieldObjectType)) {
    throw AppError.validationFailed('That is not a record type custom fields attach to', [
      { field: 'object_type', message: `Unknown object type "${raw}"` },
    ])
  }
  return raw as CustomFieldObjectType
}

export function mountCustomFieldsRoutes(
  router: Hono,
  dependencies: CustomFieldsRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActorFrom(dependencies, context)

  router.get('/custom_fields', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        objectType: readObjectTypeFilter(context),
      },
      readListParameters(context),
    )
    return context.json(pageBody(page, customFieldDefinitionResponse))
  })

  router.post('/custom_fields', async (context) => {
    const body = await readJsonBody(context, createBody)
    const definition = await dependencies.service.create(
      await requireActor(context),
      toCreateInput(body),
    )
    return context.json(customFieldDefinitionResponse(definition), 201)
  })

  router.get('/custom_fields/:id', async (context) => {
    const definition = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )
    return context.json(customFieldDefinitionResponse(definition))
  })

  router.patch('/custom_fields/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const definition = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )
    return context.json(customFieldDefinitionResponse(definition))
  })

  router.delete('/custom_fields/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))
    return context.body(null, 204)
  })
}

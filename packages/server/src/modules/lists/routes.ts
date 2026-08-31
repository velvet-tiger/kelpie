import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { isRecordTargetType } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { RECORD_TARGET_TYPES } from './schema.ts'
import type {
  AddListMemberInput,
  CreateListInput,
  ListMemberView,
  ListMembershipView,
  ListView,
  ListsService,
  UpdateListInput,
} from './service.ts'

/**
 * Wire shapes for `/v1/lists`.
 *
 * `target_type` is required on create and absent from update: a list's type is
 * fixed for its lifetime. Bodies are strict, so a caller sending `target_type`
 * on PATCH hears about it as a 422 rather than silently ignored.
 */

export const createBody = z.strictObject({
  name: z.string().min(1),
  target_type: z.enum(RECORD_TARGET_TYPES),
  description: z.string().nullable().default(null),
  consent_purpose_id: z.string().min(1).nullable().default(null),
})

export const updateBody = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().nullable(),
    consent_purpose_id: z.string().min(1).nullable(),
  })
  .partial()

export const addMemberBody = z.strictObject({
  target_type: z.enum(RECORD_TARGET_TYPES),
  target_id: z.string().min(1),
})

export interface ListsRoutesDependencies extends CredentialDependencies {
  readonly service: ListsService
}

export function toCreateInput(body: z.infer<typeof createBody>): CreateListInput {
  return {
    name: body.name,
    targetType: body.target_type,
    description: body.description,
    consentPurposeId: body.consent_purpose_id,
  }
}

export function toUpdateInput(body: z.infer<typeof updateBody>): UpdateListInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.consent_purpose_id === undefined
      ? {}
      : { consentPurposeId: body.consent_purpose_id }),
  }
}

export function toAddMemberInput(body: z.infer<typeof addMemberBody>): AddListMemberInput {
  return {
    targetType: body.target_type,
    targetId: body.target_id,
  }
}

export function listResponse(list: ListView): Record<string, unknown> {
  return {
    id: list.id,
    name: list.name,
    description: list.description,
    target_type: list.targetType,
    member_count: list.memberCount,
    consent_purpose_id: list.consentPurposeId,
    consent_purpose_slug: list.consentPurposeSlug,
    created_at: list.createdAt.toISOString(),
    updated_at: list.updatedAt.toISOString(),
  }
}

export function listMembershipResponse(
  membership: ListMembershipView,
): Record<string, unknown> {
  return {
    id: membership.id,
    list_id: membership.listId,
    list_name: membership.listName,
    list_target_type: membership.listTargetType,
    target_type: membership.targetType,
    target_id: membership.targetId,
    added_at: membership.addedAt.toISOString(),
  }
}

export function listMemberResponse(member: ListMemberView): Record<string, unknown> {
  return {
    id: member.id,
    list_id: member.listId,
    target_type: member.targetType,
    target_id: member.targetId,
    target_name: member.targetName,
    added_at: member.addedAt.toISOString(),
  }
}

function readTargetTypeFilter(context: Context): RecordTargetType | undefined {
  const raw = context.req.query('target_type')

  if (raw === undefined) {
    return undefined
  }

  if (!isRecordTargetType(raw)) {
    throw AppError.validationFailed('That is not a record type a list holds', [
      { field: 'target_type', message: `Unknown target type "${raw}"` },
    ])
  }

  return raw
}

function readMembershipTarget(context: Context): {
  targetType: RecordTargetType
  targetId: string
} {
  const rawType = context.req.query('target_type')
  const targetId = context.req.query('target_id')

  if (rawType === undefined || targetId === undefined || targetId.length === 0) {
    throw AppError.validationFailed(
      'A memberships list always names the record it is for',
      [
        { field: 'target_type', message: 'Required' },
        { field: 'target_id', message: 'Required' },
      ],
    )
  }

  if (!isRecordTargetType(rawType)) {
    throw AppError.validationFailed('That is not a record type a list holds', [
      { field: 'target_type', message: `Unknown target type "${rawType}"` },
    ])
  }

  return { targetType: rawType, targetId }
}

export function mountListsRoutes(router: Hono, dependencies: ListsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActorFrom(dependencies, context)

  router.get('/list-memberships', async (context) => {
    const { targetType, targetId } = readMembershipTarget(context)
    const memberships = await dependencies.service.membershipsFor(
      await requireActor(context),
      targetType,
      targetId,
    )

    // Not paged. A record has a small number of memberships in practice; the
    // `next_cursor: null` is here so the standard list envelope reader accepts
    // this response without a special case.
    return context.json({
      data: memberships.map(listMembershipResponse),
      next_cursor: null,
    })
  })

  router.get('/lists', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        targetType: readTargetTypeFilter(context),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, listResponse))
  })

  router.post('/lists', async (context) => {
    const body = await readJsonBody(context, createBody)
    const list = await dependencies.service.create(await requireActor(context), toCreateInput(body))

    return context.json(listResponse(list), 201)
  })

  router.get('/lists/:id', async (context) => {
    const list = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(listResponse(list))
  })

  router.patch('/lists/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const list = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(listResponse(list))
  })

  router.delete('/lists/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.get('/lists/:id/members', async (context) => {
    const page = await dependencies.service.listMembers(
      await requireActor(context),
      { listId: context.req.param('id') },
      readListParameters(context),
    )

    return context.json(pageBody(page, listMemberResponse))
  })

  router.post('/lists/:id/members', async (context) => {
    const body = await readJsonBody(context, addMemberBody)
    const member = await dependencies.service.addMember(
      await requireActor(context),
      context.req.param('id'),
      toAddMemberInput(body),
    )

    return context.json(listMemberResponse(member), 201)
  })

  router.delete('/lists/:id/members/:memberId', async (context) => {
    await dependencies.service.removeMember(
      await requireActor(context),
      context.req.param('id'),
      context.req.param('memberId'),
    )

    return context.body(null, 204)
  })
}

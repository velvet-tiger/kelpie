import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { isoDateSchema } from '../../lib/dates.ts'
import { AppError } from '../../lib/errors.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { PlanItemFilters } from './repository.ts'
import { PIPELINE_KINDS, PLAN_ITEM_STATUSES } from './schema.ts'
import type { PipelineKind, PlanItemStatus } from './schema.ts'
import type { PlanItemView, PlansService, UpdatePlanItemInput } from './service.ts'

/**
 * Wire shapes for `/v1/plan_items`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than something
 * dropped in silence.
 */

/** The full field set, without defaults. `createBody` adds those; `updateBody` makes it partial. */
const planItemShape = {
  date: isoDateSchema,
  title: z.string().min(1),
  owner_id: z.string().min(1).nullable(),
  status: z.enum(PLAN_ITEM_STATUSES),
}

/**
 * Only the target, the date, and the title are required. An absent `owner_id`
 * means unassigned rather than the caller: the panel's own form offers
 * "Unassigned" as its default, and a plan item is a note of what must happen
 * before it is a claim about who will do it.
 */
const createBody = z.strictObject({
  ...planItemShape,
  target_type: z.enum(PIPELINE_KINDS),
  target_id: z.string().min(1),
  owner_id: planItemShape.owner_id.default(null),
  status: planItemShape.status.default('todo'),
})

/** The target never moves. Re-filing an item under another record is a delete and a create. */
const updateBody = z.strictObject(planItemShape).partial()

export interface PlansRoutesDependencies extends CredentialDependencies {
  readonly service: PlansService
}

export function planItemResponse(item: PlanItemView): Record<string, unknown> {
  return {
    id: item.id,
    target_type: item.targetType,
    target_id: item.targetId,
    date: item.date,
    title: item.title,
    owner_id: item.ownerId,
    status: item.status,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  }
}

function toUpdateInput(body: z.infer<typeof updateBody>): UpdatePlanItemInput {
  return {
    ...(body.date === undefined ? {} : { date: body.date }),
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.status === undefined ? {} : { status: body.status }),
  }
}

/**
 * `?target_type=`, one pipeline kind.
 *
 * @throws AppError 422 for a kind that is not one of the four. A plan item
 *   cannot attach to a Person, so answering the person question with an empty
 *   list would read as "none yet" instead of "that is not a thing".
 */
function readTargetType(context: Context): PipelineKind | undefined {
  const raw = context.req.query('target_type')

  if (raw === undefined) {
    return undefined
  }

  const parsed = z.enum(PIPELINE_KINDS).safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('That is not a record type a plan item attaches to', [
      { field: 'target_type', message: `Use one of: ${PIPELINE_KINDS.join(', ')}` },
    ])
  }

  return parsed.data
}

/**
 * `?status=`, repeatable: `?status=todo&status=in_progress` is how a caller asks
 * for outstanding work. There is no `open` pseudo-value, because naming the two
 * real statuses says the same thing without inventing a third.
 */
function readStatuses(context: Context): readonly PlanItemStatus[] | undefined {
  const values = context.req.queries('status')

  if (values === undefined || values.length === 0) {
    return undefined
  }

  const parsed = z.array(z.enum(PLAN_ITEM_STATUSES)).safeParse(values)

  if (!parsed.success) {
    throw AppError.validationFailed('That is not a plan item status', [
      { field: 'status', message: `Use one of: ${PLAN_ITEM_STATUSES.join(', ')}` },
    ])
  }

  return parsed.data
}

/** `?from=` / `?to=`, inclusive `YYYY-MM-DD` bounds. The month calendar asks with the pair. */
function readDateBound(context: Context, name: 'from' | 'to'): string | undefined {
  const raw = context.req.query(name)

  if (raw === undefined) {
    return undefined
  }

  const parsed = isoDateSchema.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed(`"${name}" is not a date`, [
      { field: name, message: 'Use YYYY-MM-DD' },
    ])
  }

  return parsed.data
}

function readFilters(context: Context): PlanItemFilters {
  return {
    targetType: readTargetType(context),
    targetIds: readIdFilter(context, 'target_id'),
    statuses: readStatuses(context),
    from: readDateBound(context, 'from'),
    to: readDateBound(context, 'to'),
  }
}

export function mountPlansRoutes(router: Hono, dependencies: PlansRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/plan_items', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      readFilters(context),
      readListParameters(context),
    )

    return context.json(pageBody(page, planItemResponse))
  })

  router.post('/plan_items', async (context) => {
    const body = await readJsonBody(context, createBody)
    const item = await dependencies.service.create(await requireActor(context), {
      targetType: body.target_type,
      targetId: body.target_id,
      date: body.date,
      title: body.title,
      ownerId: body.owner_id,
      status: body.status,
    })

    return context.json(planItemResponse(item), 201)
  })

  router.get('/plan_items/:id', async (context) => {
    const item = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(planItemResponse(item))
  })

  router.patch('/plan_items/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const item = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(planItemResponse(item))
  })

  router.delete('/plan_items/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { DecisionFilters } from './repository.ts'
import { RECORD_TARGET_TYPES } from './schema.ts'
import type { RecordTargetType } from './schema.ts'
import type { DecisionView, DecisionsService, UpdateDecisionInput } from './service.ts'

/**
 * Wire shapes for `/v1/decisions`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than something
 * dropped in silence.
 */

/**
 * The full field set, without defaults. `createBody` adds those; `updateBody`
 * makes it partial. `rationale` is `min(1)` because the column is nullable: an
 * empty string and a null would be two spellings of "none", and a reader would
 * have to check for both.
 */
const decisionShape = {
  body: z.string().min(1),
  rationale: z.string().min(1).nullable(),
  decided_at: z.iso.datetime(),
  owner_id: z.string().min(1).nullable(),
  due_at: z.iso.datetime().nullable(),
}

/**
 * Only the target and the body are required. An absent `decided_at` means now,
 * and an absent `owner_id` means the caller — the mockup's panel stamps both
 * onto every decision it records. `owner_id: null` says nobody carries it.
 */
const createBody = z.strictObject({
  ...decisionShape,
  target_type: z.enum(RECORD_TARGET_TYPES),
  target_id: z.string().min(1),
  rationale: decisionShape.rationale.default(null),
  decided_at: decisionShape.decided_at.optional(),
  owner_id: decisionShape.owner_id.optional(),
  due_at: decisionShape.due_at.default(null),
})

/** The target never moves. Re-filing a decision under another record is a delete and a create. */
const updateBody = z.strictObject(decisionShape).partial()

export interface DecisionsRoutesDependencies extends CredentialDependencies {
  readonly service: DecisionsService
}

export function decisionResponse(decision: DecisionView): Record<string, unknown> {
  return {
    id: decision.id,
    target_type: decision.targetType,
    target_id: decision.targetId,
    body: decision.body,
    rationale: decision.rationale,
    decided_at: decision.decidedAt.toISOString(),
    owner_id: decision.ownerId,
    due_at: decision.dueAt === null ? null : decision.dueAt.toISOString(),
    created_at: decision.createdAt.toISOString(),
    updated_at: decision.updatedAt.toISOString(),
  }
}

function toUpdateInput(body: z.infer<typeof updateBody>): UpdateDecisionInput {
  return {
    ...(body.body === undefined ? {} : { body: body.body }),
    ...(body.rationale === undefined ? {} : { rationale: body.rationale }),
    ...(body.decided_at === undefined ? {} : { decidedAt: new Date(body.decided_at) }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.due_at === undefined ? {} : { dueAt: body.due_at === null ? null : new Date(body.due_at) }),
  }
}

/**
 * `?target_type=`, one record type.
 *
 * @throws AppError 422 for a type nothing attaches a decision to. Answering it
 *   with an empty list would read as "none yet" instead of "that is not a
 *   thing".
 */
function readTargetType(context: Context): RecordTargetType | undefined {
  const raw = context.req.query('target_type')

  if (raw === undefined) {
    return undefined
  }

  const parsed = z.enum(RECORD_TARGET_TYPES).safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('That is not a record type a decision attaches to', [
      { field: 'target_type', message: `Use one of: ${RECORD_TARGET_TYPES.join(', ')}` },
    ])
  }

  return parsed.data
}

/**
 * Unlike a note list, a decision list stands on its own: `/decisions` is a
 * workspace page, so every filter here is optional.
 */
function readFilters(context: Context): DecisionFilters {
  return {
    targetType: readTargetType(context),
    targetIds: readIdFilter(context, 'target_id'),
    term: context.req.query('q'),
  }
}

export function mountDecisionsRoutes(
  router: Hono,
  dependencies: DecisionsRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/decisions', async (context) => {
    const page = await dependencies.service.list(
      await requireActor(context),
      readFilters(context),
      readListParameters(context),
    )

    return context.json(pageBody(page, decisionResponse))
  })

  router.post('/decisions', async (context) => {
    const body = await readJsonBody(context, createBody)
    const decision = await dependencies.service.create(await requireActor(context), {
      targetType: body.target_type,
      targetId: body.target_id,
      body: body.body,
      rationale: body.rationale,
      decidedAt: body.decided_at === undefined ? undefined : new Date(body.decided_at),
      ownerId: body.owner_id,
      dueAt: body.due_at === null ? null : new Date(body.due_at),
    })

    return context.json(decisionResponse(decision), 201)
  })

  router.get('/decisions/:id', async (context) => {
    const decision = await dependencies.service.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(decisionResponse(decision))
  })

  router.patch('/decisions/:id', async (context) => {
    const body = await readJsonBody(context, updateBody)
    const decision = await dependencies.service.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateInput(body),
    )

    return context.json(decisionResponse(decision))
  })

  router.delete('/decisions/:id', async (context) => {
    await dependencies.service.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

import { z } from 'zod'

import { PIPELINE_KINDS, PLAN_ITEM_STATUSES } from './values.ts'
import type { PipelineKind, PlanItemStatus } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/plan_items`.
 *
 * A plan item is a dated action on one of the four pipelines. It replaces any
 * next-step text field (`brief.md`): the date, the owner, and the status are
 * columns, so "what is overdue" is a query rather than a read of prose.
 *
 * `ownerId` is a workspace member id and is null when nobody has taken it. The
 * status is never null: the table defaults it to `todo`, so a plan item always
 * says where it stands.
 */

export interface PlanItem extends RecordTimestamps {
  readonly id: string
  readonly targetType: PipelineKind
  readonly targetId: string
  /** `YYYY-MM-DD`, per `api.md` date-only fields. */
  readonly date: string
  readonly title: string
  readonly ownerId: string | null
  readonly status: PlanItemStatus
}

export const planItemSchema: z.ZodType<PlanItem, unknown> = z
  .object({
    id: idSchema,
    target_type: z.enum(PIPELINE_KINDS),
    target_id: idSchema,
    date: z.string(),
    title: z.string(),
    owner_id: idSchema.nullable(),
    status: z.enum(PLAN_ITEM_STATUSES),
    ...recordTimestamps,
  })
  .transform(
    (wire): PlanItem => ({
      id: wire.id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      date: wire.date,
      title: wire.title,
      ownerId: wire.owner_id,
      status: wire.status,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreatePlanItemInput {
  readonly targetType: PipelineKind
  readonly targetId: string
  readonly date: string
  readonly title: string
  readonly ownerId?: string | null
  readonly status?: PlanItemStatus
}

export function createPlanItemBody(input: CreatePlanItemInput): Record<string, unknown> {
  return definedFields({
    target_type: input.targetType,
    target_id: input.targetId,
    date: input.date,
    title: input.title,
    owner_id: input.ownerId,
    status: input.status,
  })
}

/** The target never moves: re-filing a plan item under another record is a delete and a create. */
export interface PlanItemInput {
  readonly date?: string
  readonly title?: string
  readonly ownerId?: string | null
  readonly status?: PlanItemStatus
}

export function planItemBody(input: PlanItemInput): Record<string, unknown> {
  return definedFields({
    date: input.date,
    title: input.title,
    owner_id: input.ownerId,
    status: input.status,
  })
}

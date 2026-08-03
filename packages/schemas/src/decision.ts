import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import {
  definedFields,
  idSchema,
  nullableTimestampSchema,
  recordTimestamps,
  timestampSchema,
} from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/decisions`.
 *
 * A decision is what the workspace decided or promised: a commitment agents
 * must not contradict, kept as a queryable record rather than note text.
 *
 * `ownerId` is a workspace member id, null when nobody carries the commitment.
 * `dueAt` is the optional deadline on it; `decidedAt` is when it was made and is
 * never null.
 */

export interface Decision extends RecordTimestamps {
  readonly id: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly rationale: string | null
  readonly decidedAt: Date
  readonly ownerId: string | null
  readonly dueAt: Date | null
}

export const decisionSchema: z.ZodType<Decision, unknown> = z
  .object({
    id: idSchema,
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    body: z.string(),
    rationale: z.string().nullable(),
    decided_at: timestampSchema,
    owner_id: idSchema.nullable(),
    due_at: nullableTimestampSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Decision => ({
      id: wire.id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      body: wire.body,
      rationale: wire.rationale,
      decidedAt: wire.decided_at,
      ownerId: wire.owner_id,
      dueAt: wire.due_at,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateDecisionInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly rationale?: string | null
  /** Absent means now: most decisions are recorded as they are made. */
  readonly decidedAt?: Date
  /** Absent means the caller; null means nobody carries it. */
  readonly ownerId?: string | null
  readonly dueAt?: Date | null
}

export function createDecisionBody(input: CreateDecisionInput): Record<string, unknown> {
  return definedFields({
    target_type: input.targetType,
    target_id: input.targetId,
    body: input.body,
    rationale: input.rationale,
    decided_at: input.decidedAt === undefined ? undefined : input.decidedAt.toISOString(),
    owner_id: input.ownerId,
    due_at:
      input.dueAt === undefined ? undefined : input.dueAt === null ? null : input.dueAt.toISOString(),
  })
}

/** The target never moves: re-filing a decision under another record is a delete and a create. */
export interface DecisionInput {
  readonly body?: string
  readonly rationale?: string | null
  readonly decidedAt?: Date
  readonly ownerId?: string | null
  readonly dueAt?: Date | null
}

export function decisionBody(input: DecisionInput): Record<string, unknown> {
  return definedFields({
    body: input.body,
    rationale: input.rationale,
    decided_at: input.decidedAt === undefined ? undefined : input.decidedAt.toISOString(),
    owner_id: input.ownerId,
    due_at:
      input.dueAt === undefined ? undefined : input.dueAt === null ? null : input.dueAt.toISOString(),
  })
}

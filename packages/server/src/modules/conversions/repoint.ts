import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { PipelineKind } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../../runtime/transaction.ts'
import * as activityRepository from '../activities/repository.ts'
import * as agentRunRepository from '../agent-tasks/repository.ts'
import * as decisionRepository from '../decisions/repository.ts'
import { formAttachTargets } from '../forms/schema.ts'
import * as listRepository from '../lists/repository.ts'
import * as noteRepository from '../notes/repository.ts'
import * as planRepository from '../plans/repository.ts'

/**
 * The polymorphic repoint rule: mirror of `deleteRecordsAttachedTo`, used when
 * a pipeline record converts to another type and its history should follow the
 * new record while the source stays in place.
 */

export interface PipelineTargetRef {
  readonly targetType: PipelineKind
  readonly targetId: string
}

/**
 * @param db Must be the caller's transaction.
 * @returns How many rows were repointed or removed, for the caller's activity trail.
 */
export async function repointRecordsAttachedTo(
  db: Queryable,
  workspaceId: string,
  from: PipelineTargetRef,
  to: PipelineTargetRef,
): Promise<number> {
  const fromType = from.targetType
  const fromId = from.targetId
  const toType = to.targetType
  const toId = to.targetId

  const notes = await noteRepository.repointForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const activities = await activityRepository.repointForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const decisions = await decisionRepository.repointForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const plans = await planRepository.repointForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const agentRuns = await agentRunRepository.repointForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const attachTargets = await repointFormAttachTargets(
    db,
    workspaceId,
    fromType,
    fromId,
    toType,
    toId,
  )
  const memberships = await listRepository.deleteMembershipsForTarget(
    db,
    workspaceId,
    fromType,
    fromId,
  )

  return notes + activities + decisions + plans + agentRuns + attachTargets + memberships
}

async function repointFormAttachTargets(
  db: Queryable,
  workspaceId: string,
  fromType: PipelineKind,
  fromId: string,
  toType: PipelineKind,
  toId: string,
): Promise<number> {
  const held = await db
    .select({ formId: formAttachTargets.formId })
    .from(formAttachTargets)
    .where(
      and(
        eq(formAttachTargets.workspaceId, workspaceId),
        eq(formAttachTargets.targetType, fromType),
        eq(formAttachTargets.targetId, fromId),
      ),
    )

  if (held.length === 0) {
    return 0
  }

  await db
    .delete(formAttachTargets)
    .where(
      and(
        eq(formAttachTargets.workspaceId, workspaceId),
        eq(formAttachTargets.targetType, fromType),
        eq(formAttachTargets.targetId, fromId),
      ),
    )

  await db.insert(formAttachTargets).values(
    held.map((row: { formId: string }) => ({
      workspaceId,
      formId: row.formId,
      targetType: toType,
      targetId: toId,
    })),
  )

  return held.length
}

/** Whether a pipeline kind is one of the five convertible types. */
export function isPipelineKind(value: string): value is PipelineKind {
  return (PIPELINE_KINDS as readonly string[]).includes(value)
}

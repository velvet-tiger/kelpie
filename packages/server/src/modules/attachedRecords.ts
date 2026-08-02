import type { Queryable } from '../runtime/transaction.ts'
import * as activityRepository from './activities/repository.ts'
import * as decisionRepository from './decisions/repository.ts'
import * as noteRepository from './notes/repository.ts'

/**
 * The polymorphic delete rule from `schema.md`, in one place.
 *
 * Notes, activities and decisions attach to a target through `target_type` plus
 * `target_id` with no foreign key, so no cascade removes them. Whoever deletes
 * the target deletes these, in the same transaction, or the rows outlive the
 * record they described and reappear the day an id is reused.
 *
 * `plan_items` attach the same way but their check constraint allows only the
 * four pipeline types, so nothing here can own one. The Deals module adds them.
 */

/** Target types that can own attached records here. Pipelines widen this. */
export type AttachableTargetType = 'person' | 'company'

/**
 * @param db Must be the caller's transaction. Called on its own, this deletes the
 *   dependents of a record that still exists.
 * @returns How many rows were removed, for the caller's activity trail.
 */
export async function deleteRecordsAttachedTo(
  db: Queryable,
  workspaceId: string,
  targetType: AttachableTargetType,
  targetId: string,
): Promise<number> {
  // Sequential, not concurrent: a transaction is one connection, and three
  // statements racing down it is not something to rely on for a cheap delete.
  const notes = await noteRepository.deleteForTarget(db, workspaceId, targetType, targetId)
  const activities = await activityRepository.deleteForTarget(db, workspaceId, targetType, targetId)
  const decisions = await decisionRepository.deleteForTarget(db, workspaceId, targetType, targetId)

  return notes + activities + decisions
}

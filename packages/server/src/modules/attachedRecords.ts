import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { PipelineKind } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../runtime/transaction.ts'
import * as activityRepository from './activities/repository.ts'
import * as decisionRepository from './decisions/repository.ts'
import { formAttachTargets } from './forms/schema.ts'
import { candidates } from './hiring/schema.ts'
import * as listRepository from './lists/repository.ts'
import * as noteRepository from './notes/repository.ts'
import * as personLinks from './personLinks.ts'
import * as planRepository from './plans/repository.ts'

/**
 * The polymorphic delete rule from `schema.md`, in one place.
 *
 * Notes, activities and decisions attach to a target through `target_type` plus
 * `target_id` with no foreign key, so no cascade removes them. Whoever deletes
 * the target deletes these, in the same transaction, or the rows outlive the
 * record they described and reappear the day an id is reused.
 *
 * `plan_items` attach the same way but their check constraint allows only the
 * four pipeline types, so they are removed only for those targets. `person_links`
 * follows the same rule: it holds a person's involvement in a pipeline record
 * and its check constraint allows only the four pipeline types, so a deleted
 * deal/opportunity/raise/partnership sheds its people here. `form_attach_targets`
 * is the same shape: forms pinning submitters into a pre-existing pipeline
 * record shed the mapping when the target goes.
 */

/** Target types that can own attached records here. */
export type AttachableTargetType = 'person' | 'company' | 'candidate' | PipelineKind

const PLAN_TARGET_TYPES: ReadonlySet<string> = new Set(PIPELINE_KINDS)

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
  // Sequential, not concurrent: a transaction is one connection, and five
  // statements racing down it is not something to rely on for a cheap delete.
  const notes = await noteRepository.deleteForTarget(db, workspaceId, targetType, targetId)
  const activities = await activityRepository.deleteForTarget(db, workspaceId, targetType, targetId)
  const decisions = await decisionRepository.deleteForTarget(db, workspaceId, targetType, targetId)
  const plans = PLAN_TARGET_TYPES.has(targetType)
    ? await planRepository.deleteForTarget(db, workspaceId, targetType, targetId)
    : 0
  const links = PLAN_TARGET_TYPES.has(targetType)
    ? await personLinks.deleteLinksForTarget(db, workspaceId, {
        targetType: targetType as PipelineKind,
        targetId,
      })
    : 0
  const attachTargets = PLAN_TARGET_TYPES.has(targetType)
    ? (
        await db
          .delete(formAttachTargets)
          .where(
            and(
              eq(formAttachTargets.workspaceId, workspaceId),
              eq(formAttachTargets.targetType, targetType),
              eq(formAttachTargets.targetId, targetId),
            ),
          )
          .returning({ formId: formAttachTargets.formId })
      ).length
    : 0
  const memberships = await listRepository.deleteMembershipsForTarget(
    db,
    workspaceId,
    targetType,
    targetId,
  )

  return notes + activities + decisions + plans + links + attachTargets + memberships
}

/**
 * The same cleanup for the candidacies a person's delete takes with them.
 *
 * `candidates.person_id` cascades, so those rows go without any service seeing
 * them, and the interview notes attached to each would outlive the candidacy
 * they described. This is the only link in the schema that both dies by cascade
 * and owns attached records, which is why it is the only one with a helper here.
 *
 * Reads the `candidates` *table* rather than the hiring repository: the module
 * that owns those rows registers after `people`, and `architecture.md` allows a
 * table read where a repository import would invert the dependency.
 *
 * @param db Must be the caller's transaction, so a refused person delete brings
 *   these rows back with it.
 * @returns How many attached rows were removed.
 */
export async function deleteRecordsAttachedToCandidaciesOf(
  db: Queryable,
  workspaceId: string,
  personId: string,
): Promise<number> {
  const held = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.personId, personId)))

  let removed = 0

  for (const candidacy of held) {
    removed += await deleteRecordsAttachedTo(db, workspaceId, 'candidate', candidacy.id)
  }

  return removed
}

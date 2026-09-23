import {
  EVENT_ASSOCIATION_TARGET_TYPES,
  FORM_ATTACH_TARGET_TYPES,
  PIPELINE_KINDS,
  PLAN_ITEM_TARGET_TYPES,
} from '@kelpie/schemas'
import type { PipelineKind } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'

import type { Queryable } from '../runtime/transaction.ts'
import * as activityRepository from './activities/repository.ts'
import * as decisionRepository from './decisions/repository.ts'
import { attendances, eventAssociations } from './events/schema.ts'
import { formAttachTargets } from './forms/schema.ts'
import { candidates } from './hiring/schema.ts'
import * as listRepository from './lists/repository.ts'
import * as noteRepository from './notes/repository.ts'
import * as personLinks from './personLinks.ts'
import * as planRepository from './plans/repository.ts'

/**
 * The polymorphic delete rule, in one place.
 *
 * Notes, activities and decisions attach to a target through `target_type` plus
 * `target_id` with no foreign key, so no cascade removes them. Whoever deletes
 * the target deletes these, in the same transaction, or the rows outlive the
 * record they described and reappear the day an id is reused.
 *
 * `plan_items` attach the same way but their check constraint allows the
 * pipeline types plus Event, so they are removed only for those targets.
 * `person_links` stays pipeline-only. `form_attach_targets` follows the plan
 * set (pipelines plus Event). `event_associations` is Event-only: deleting the
 * other record strips rows that pointed at it.
 */

/** Target types that can own attached records here. */
export type AttachableTargetType =
  | 'person'
  | 'company'
  | 'candidate'
  | 'event'
  | 'attendance'
  | PipelineKind

const PLAN_TARGET_TYPES: ReadonlySet<string> = new Set(PLAN_ITEM_TARGET_TYPES)
const LINK_TARGET_TYPES: ReadonlySet<string> = new Set(PIPELINE_KINDS)
const FORM_ATTACH_TYPES: ReadonlySet<string> = new Set(FORM_ATTACH_TARGET_TYPES)
const ASSOCIATION_TARGET_TYPES: ReadonlySet<string> = new Set(EVENT_ASSOCIATION_TARGET_TYPES)

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
  const links = LINK_TARGET_TYPES.has(targetType)
    ? await personLinks.deleteLinksForTarget(db, workspaceId, {
        targetType: targetType as PipelineKind,
        targetId,
      })
    : 0
  const attachTargets = FORM_ATTACH_TYPES.has(targetType)
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
  const associations = ASSOCIATION_TARGET_TYPES.has(targetType)
    ? await deleteEventAssociationsForTarget(db, workspaceId, targetType, targetId)
    : 0

  return notes + activities + decisions + plans + links + attachTargets + memberships + associations
}

/**
 * Event↔record rows have no FK to the target, so the target's delete must strip
 * them. Event delete itself cascades `event_id`. Role is not an attachable
 * notes target, so its service calls this helper directly.
 */
export async function deleteEventAssociationsForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(eventAssociations)
    .where(
      and(
        eq(eventAssociations.workspaceId, workspaceId),
        eq(eventAssociations.targetType, targetType),
        eq(eventAssociations.targetId, targetId),
      ),
    )
    .returning({ id: eventAssociations.id })

  return deleted.length
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
 * that owns those rows registers after `people`, and a table read is allowed
 * where a repository import would invert the dependency.
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

/**
 * The same cleanup for Attendances a person's (or Event's) delete takes with
 * them. `attendances.person_id` / `event_id` cascade, so notes on those rows
 * would otherwise outlive the Attendance.
 */
export async function deleteRecordsAttachedToAttendancesOf(
  db: Queryable,
  workspaceId: string,
  filter: { readonly personId: string } | { readonly eventId: string },
): Promise<number> {
  const held = await db
    .select({ id: attendances.id })
    .from(attendances)
    .where(
      and(
        eq(attendances.workspaceId, workspaceId),
        'personId' in filter
          ? eq(attendances.personId, filter.personId)
          : eq(attendances.eventId, filter.eventId),
      ),
    )

  let removed = 0

  for (const attendance of held) {
    removed += await deleteRecordsAttachedTo(db, workspaceId, 'attendance', attendance.id)
  }

  return removed
}

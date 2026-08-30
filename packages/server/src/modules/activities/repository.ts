import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { PipelineKind } from '@kelpie/schemas'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import * as personLinks from '../personLinks.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { activities } from './schema.ts'

export type ActivityRecord = typeof activities.$inferSelect

/** The writable column shape. The recorder builds one of these; nothing else knows the column names. */
export type ActivityColumns = typeof activities.$inferInsert

/**
 * Only `created_at`. An activity carries no other non-nullable value worth
 * ordering by, and a keyset cannot seek past a null.
 */
export const ACTIVITY_SORTS: SortableFields<ActivityRecord> = {
  created_at: timestampSort(activities.createdAt, (activity) => activity.createdAt),
}

export const DEFAULT_ACTIVITY_SORT = '-created_at'

/** One `(target_type, target_id)` pair a timeline reads from. */
export interface ActivityTarget {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export async function insertActivity(
  db: Queryable,
  values: ActivityColumns,
): Promise<ActivityRecord> {
  const [created] = await db.insert(activities).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting activity ${values.id} returned no row`)
  }

  return created
}

/**
 * The related records whose activity rolls up onto a person or company timeline.
 *
 * A deal moving to Proposal is the most useful thing on that company's timeline
 * and it is not stored against the company. Which relations roll up was settled
 * by the mockup (`activitiesFor` in `mockups/src/data/seed.ts`): deals,
 * opportunities and partnerships for a company, and for a person only the two
 * they can be attached to.
 *
 * Reads the pipeline tables directly rather than composing their repositories,
 * which is the rule already set for a query spanning a relation
 * (`architecture.md`).
 *
 * @returns The roll-up targets only. The caller adds the record's own.
 */
export async function listRolledUpTargets(
  db: Queryable,
  workspaceId: string,
  targetType: RecordTargetType,
  targetId: string,
): Promise<ActivityTarget[]> {
  if (targetType === 'company') {
    const [dealRows, opportunityRows, partnershipRows, enquiryRows] = await Promise.all([
      db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.workspaceId, workspaceId), eq(deals.companyId, targetId))),
      db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.companyId, targetId)),
        ),
      db
        .select({ id: partnerships.id })
        .from(partnerships)
        .where(and(eq(partnerships.workspaceId, workspaceId), eq(partnerships.companyId, targetId))),
      db
        .select({ id: enquiries.id })
        .from(enquiries)
        .where(and(eq(enquiries.workspaceId, workspaceId), eq(enquiries.companyId, targetId))),
    ])

    return [
      ...dealRows.map((row) => ({ targetType: 'deal' as const, targetId: row.id })),
      ...opportunityRows.map((row) => ({ targetType: 'opportunity' as const, targetId: row.id })),
      ...partnershipRows.map((row) => ({ targetType: 'partnership' as const, targetId: row.id })),
      ...enquiryRows.map((row) => ({ targetType: 'enquiry' as const, targetId: row.id })),
    ]
  }

  if (targetType === 'person') {
    // person_links carries all four pipeline kinds in one table, so a person's
    // roll-up is one read regardless of how many pipelines they touch. The
    // shared helper's `PipelineKind` narrows to the check-constraint set, which
    // is exactly what an ActivityTarget expects to receive.
    const links = await personLinks.listTargetsOfPerson(db, workspaceId, targetId)

    return links.map((link) => ({
      targetType: link.targetType satisfies PipelineKind as RecordTargetType,
      targetId: link.targetId,
    }))
  }

  return []
}

/**
 * Grouped by target type, so the index on `(workspace_id, target_type,
 * target_id)` stays usable for each group instead of degrading into a long list
 * of independent pair comparisons.
 */
function matchesAnyTarget(targets: readonly ActivityTarget[]): SQL | undefined {
  const idsByType = new Map<RecordTargetType, string[]>()

  for (const target of targets) {
    const ids = idsByType.get(target.targetType)

    if (ids === undefined) {
      idsByType.set(target.targetType, [target.targetId])
    } else {
      ids.push(target.targetId)
    }
  }

  return or(
    ...[...idsByType].map(([targetType, ids]) =>
      and(eq(activities.targetType, targetType), inArray(activities.targetId, ids)),
    ),
  )
}

/**
 * @param targets The record's own target plus its roll-up set. An empty list
 *   answers no rows rather than every row in the workspace, which is what an
 *   omitted condition would have meant.
 * @returns Up to `window.fetchLimit` rows: one more than the page, so the caller
 *   can tell there is a next one.
 */
export function listActivities(
  db: Queryable,
  workspaceId: string,
  targets: readonly ActivityTarget[],
  window: ListWindow<ActivityRecord>,
): Promise<ActivityRecord[]> {
  return db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.workspaceId, workspaceId),
        targets.length === 0 ? sql`false` : matchesAnyTarget(targets),
        keysetCondition(window, activities.id),
      ),
    )
    .orderBy(...orderByWindow(window, activities.id))
    .limit(window.fetchLimit)
}

/**
 * Removes every activity attached to a target.
 *
 * The target is polymorphic and carries no foreign key, so nothing in the
 * database deletes these. The service that deletes the target calls this inside
 * the same transaction (`schema.md`).
 */
export async function deleteForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(activities)
    .where(
      and(
        eq(activities.workspaceId, workspaceId),
        eq(activities.targetType, targetType),
        eq(activities.targetId, targetId),
      ),
    )
    .returning({ id: activities.id })

  return deleted.length
}

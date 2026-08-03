import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import {
  keysetCondition,
  orderByWindow,
  textSort,
  timestampSort,
} from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { planItems } from './schema.ts'
import type { PipelineKind, PlanItemStatus } from './schema.ts'

export type PlanItemRecord = typeof planItems.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type PlanItemColumns = typeof planItems.$inferInsert

/**
 * The sort fields `?sort=` documents for plan items.
 *
 * `date` is a `YYYY-MM-DD` string in and out of the driver, so it sorts as text
 * and its cursor round-trips as itself. Every column here is non-nullable,
 * because a keyset cannot seek past a null.
 */
export const PLAN_ITEM_SORTS: SortableFields<PlanItemRecord> = {
  date: textSort(planItems.date, (item) => item.date),
  created_at: timestampSort(planItems.createdAt, (item) => item.createdAt),
  updated_at: timestampSort(planItems.updatedAt, (item) => item.updatedAt),
}

/**
 * Soonest first. Unlike every other resource, a plan list is read forwards: it
 * answers "what is next", so the oldest open item belongs at the top.
 */
export const DEFAULT_PLAN_ITEM_SORT = 'date'

export interface PlanItemFilters {
  /** `?target_type=`: one pipeline. The Planning page's type filter. */
  readonly targetType?: PipelineKind | undefined
  /** `?target_id=`, repeatable: one record's panel, or a page of records' next steps. */
  readonly targetIds?: readonly string[] | undefined
  /** `?status=`, repeatable. Naming the two open ones is how a caller asks for outstanding work. */
  readonly statuses?: readonly PlanItemStatus[] | undefined
  /** `?from=`, inclusive `YYYY-MM-DD`. */
  readonly from?: string | undefined
  /** `?to=`, inclusive `YYYY-MM-DD`. The calendar asks for one month with the pair. */
  readonly to?: string | undefined
}

function conditionsFor(workspaceId: string, filters: PlanItemFilters): (SQL | undefined)[] {
  return [
    eq(planItems.workspaceId, workspaceId),
    filters.targetType === undefined ? undefined : eq(planItems.targetType, filters.targetType),
    filters.targetIds === undefined ? undefined : inArray(planItems.targetId, filters.targetIds),
    filters.statuses === undefined ? undefined : inArray(planItems.status, filters.statuses),
    filters.from === undefined ? undefined : gte(planItems.date, filters.from),
    filters.to === undefined ? undefined : lte(planItems.date, filters.to),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listPlanItems(
  db: Queryable,
  workspaceId: string,
  filters: PlanItemFilters,
  window: ListWindow<PlanItemRecord>,
): Promise<PlanItemRecord[]> {
  return db
    .select()
    .from(planItems)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, planItems.id)))
    .orderBy(...orderByWindow(window, planItems.id))
    .limit(window.fetchLimit)
}

export async function findPlanItem(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<PlanItemRecord | undefined> {
  const [found] = await db
    .select()
    .from(planItems)
    .where(and(eq(planItems.workspaceId, workspaceId), eq(planItems.id, id)))
    .limit(1)

  return found
}

export async function insertPlanItem(
  db: Queryable,
  values: PlanItemColumns,
): Promise<PlanItemRecord> {
  const [created] = await db.insert(planItems).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting plan item ${values.id} returned no row`)
  }

  return created
}

export async function updatePlanItem(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<PlanItemColumns>,
): Promise<PlanItemRecord | undefined> {
  const [updated] = await db
    .update(planItems)
    .set(changes)
    .where(and(eq(planItems.workspaceId, workspaceId), eq(planItems.id, id)))
    .returning()

  return updated
}

export async function deletePlanItem(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(planItems)
    .where(and(eq(planItems.workspaceId, workspaceId), eq(planItems.id, id)))
    .returning({ id: planItems.id })

  return deleted.length
}

/**
 * Removes every plan item attached to a target.
 *
 * The target is polymorphic and carries no foreign key, so nothing in the
 * database deletes these. The service that deletes the target calls this inside
 * the same transaction (`attachedRecords.ts`).
 */
export async function deleteForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(planItems)
    .where(
      and(
        eq(planItems.workspaceId, workspaceId),
        eq(planItems.targetType, targetType),
        eq(planItems.targetId, targetId),
      ),
    )
    .returning({ id: planItems.id })

  return deleted.length
}

/** Whether a member belongs to this workspace, for validating `owner_id`. */
export async function memberExists(
  db: Queryable,
  workspaceId: string,
  memberId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.id, memberId)))
    .limit(1)

  return found !== undefined
}

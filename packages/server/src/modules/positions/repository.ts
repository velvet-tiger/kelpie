import { and, eq, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { positions } from './schema.ts'

export type PositionRecord = typeof positions.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type PositionColumns = typeof positions.$inferInsert

export const POSITION_SORTS: SortableFields<PositionRecord> = {
  title: textSort(positions.title, (position) => position.title),
  created_at: timestampSort(positions.createdAt, (position) => position.createdAt),
  updated_at: timestampSort(positions.updatedAt, (position) => position.updatedAt),
}

export const DEFAULT_POSITION_SORT = '-created_at'

/**
 * No `?q=`. A position holds one field a user could search, and it is already
 * reachable from both sides through the person and company filters.
 */
export interface PositionFilters {
  /** `?person_id=`, repeatable: the positions held by any of these people. */
  readonly personIds?: readonly string[] | undefined
  /** `?company_id=`, repeatable: the positions held at any of these companies. */
  readonly companyIds?: readonly string[] | undefined
}

function conditionsFor(workspaceId: string, filters: PositionFilters): (SQL | undefined)[] {
  return [
    eq(positions.workspaceId, workspaceId),
    filters.personIds === undefined ? undefined : inArray(positions.personId, filters.personIds),
    filters.companyIds === undefined ? undefined : inArray(positions.companyId, filters.companyIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listPositions(
  db: Queryable,
  workspaceId: string,
  filters: PositionFilters,
  window: ListWindow<PositionRecord>,
): Promise<PositionRecord[]> {
  return db
    .select()
    .from(positions)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, positions.id)))
    .orderBy(...orderByWindow(window, positions.id))
    .limit(window.fetchLimit)
}

export async function findPosition(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<PositionRecord | undefined> {
  const [found] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.workspaceId, workspaceId), eq(positions.id, id)))
    .limit(1)

  return found
}

export async function insertPosition(
  db: Queryable,
  values: PositionColumns,
): Promise<PositionRecord> {
  const [created] = await db.insert(positions).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting position ${values.id} returned no row`)
  }

  return created
}

export async function updatePosition(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<PositionColumns>,
): Promise<PositionRecord | undefined> {
  const [updated] = await db
    .update(positions)
    .set(changes)
    .where(and(eq(positions.workspaceId, workspaceId), eq(positions.id, id)))
    .returning()

  return updated
}

export async function deletePosition(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(positions)
    .where(and(eq(positions.workspaceId, workspaceId), eq(positions.id, id)))
    .returning({ id: positions.id })

  return deleted.length
}

import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { consentPurposes } from './schema.ts'

export type ConsentPurposeRecord = typeof consentPurposes.$inferSelect
export type ConsentPurposeColumns = typeof consentPurposes.$inferInsert

export const CONSENT_PURPOSE_SORTS: SortableFields<ConsentPurposeRecord> = {
  sort_order: {
    column: consentPurposes.sortOrder,
    valueOf: (row) => String(row.sortOrder),
    parse: (value) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) {
        throw new Error('sort_order cursor is not a whole number')
      }
      return parsed
    },
  },
  label: textSort(consentPurposes.label, (row) => row.label),
  slug: textSort(consentPurposes.slug, (row) => row.slug),
  created_at: timestampSort(consentPurposes.createdAt, (row) => row.createdAt),
  updated_at: timestampSort(consentPurposes.updatedAt, (row) => row.updatedAt),
}

export const DEFAULT_CONSENT_PURPOSE_SORT = 'sort_order'

export interface ConsentPurposeFilters {
  readonly term?: string | undefined
}

function conditionsFor(workspaceId: string, filters: ConsentPurposeFilters): (SQL | undefined)[] {
  return [
    eq(consentPurposes.workspaceId, workspaceId),
    filters.term === undefined ? undefined : ilike(consentPurposes.label, containsPattern(filters.term)),
  ]
}

export function listPurposes(
  db: Queryable,
  workspaceId: string,
  filters: ConsentPurposeFilters,
  window: ListWindow<ConsentPurposeRecord>,
): Promise<ConsentPurposeRecord[]> {
  return db
    .select()
    .from(consentPurposes)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, consentPurposes.id)))
    .orderBy(...orderByWindow(window, consentPurposes.id))
    .limit(window.fetchLimit)
}

export async function findPurpose(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<ConsentPurposeRecord | undefined> {
  const [found] = await db
    .select()
    .from(consentPurposes)
    .where(and(eq(consentPurposes.workspaceId, workspaceId), eq(consentPurposes.id, id)))
    .limit(1)

  return found
}

export async function findPurposeBySlug(
  db: Queryable,
  workspaceId: string,
  slug: string,
): Promise<ConsentPurposeRecord | undefined> {
  const [found] = await db
    .select()
    .from(consentPurposes)
    .where(and(eq(consentPurposes.workspaceId, workspaceId), eq(consentPurposes.slug, slug)))
    .limit(1)

  return found
}

export function purposesForWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<ConsentPurposeRecord[]> {
  return db
    .select()
    .from(consentPurposes)
    .where(eq(consentPurposes.workspaceId, workspaceId))
    .orderBy(asc(consentPurposes.sortOrder), asc(consentPurposes.id))
}

/** The purposes with any of these ids, in this workspace. Used by cross-module checks. */
export function listPurposesByIds(
  db: Queryable,
  workspaceId: string,
  ids: readonly string[],
): Promise<ConsentPurposeRecord[]> {
  if (ids.length === 0) return Promise.resolve([])
  return db
    .select()
    .from(consentPurposes)
    .where(
      and(
        eq(consentPurposes.workspaceId, workspaceId),
        inArray(consentPurposes.id, [...ids]),
      ),
    )
}

export async function countPurposes(db: Queryable, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(consentPurposes)
    .where(eq(consentPurposes.workspaceId, workspaceId))

  return Number(row?.count ?? 0)
}

export async function insertPurpose(
  db: Queryable,
  values: ConsentPurposeColumns,
): Promise<ConsentPurposeRecord> {
  const [created] = await db.insert(consentPurposes).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting consent_purpose ${values.id} returned no row`)
  }

  return created
}

export async function updatePurpose(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<ConsentPurposeColumns>,
): Promise<ConsentPurposeRecord | undefined> {
  const [updated] = await db
    .update(consentPurposes)
    .set(changes)
    .where(and(eq(consentPurposes.workspaceId, workspaceId), eq(consentPurposes.id, id)))
    .returning()

  return updated
}

export async function deletePurpose(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(consentPurposes)
    .where(and(eq(consentPurposes.workspaceId, workspaceId), eq(consentPurposes.id, id)))
    .returning({ id: consentPurposes.id })

  return deleted.length
}

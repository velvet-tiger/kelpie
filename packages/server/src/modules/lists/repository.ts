import { and, eq, ilike, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { listMembers, lists } from './schema.ts'

export type ListRecord = typeof lists.$inferSelect
export type ListColumns = typeof lists.$inferInsert

export type ListMemberRecord = typeof listMembers.$inferSelect
export type ListMemberColumns = typeof listMembers.$inferInsert

/**
 * The stored row with the rollup a UI index page needs. `member_count` is
 * computed at read time rather than maintained on write so an unrelated bug
 * cannot leave the count out of step with the actual rows.
 */
export type ListWithCount = ListRecord & { readonly memberCount: number }

export const LIST_SORTS: SortableFields<ListWithCount> = {
  name: textSort(lists.name, (list) => list.name),
  created_at: timestampSort(lists.createdAt, (list) => list.createdAt),
  updated_at: timestampSort(lists.updatedAt, (list) => list.updatedAt),
}

export const DEFAULT_LIST_SORT = '-updated_at'

export interface ListFilters {
  readonly term?: string | undefined
  readonly targetType?: RecordTargetType | undefined
}

function conditionsFor(workspaceId: string, filters: ListFilters): (SQL | undefined)[] {
  const term = filters.term
  const targetType = filters.targetType

  return [
    eq(lists.workspaceId, workspaceId),
    term === undefined ? undefined : ilike(lists.name, containsPattern(term)),
    targetType === undefined ? undefined : eq(lists.targetType, targetType),
  ]
}

/**
 * @returns Up to `window.fetchLimit` rows: one more than the page, so the
 *   caller can tell there is a next one. Each row carries the count of members
 *   attached to it.
 */
export async function listLists(
  db: Queryable,
  workspaceId: string,
  filters: ListFilters,
  window: ListWindow<ListWithCount>,
): Promise<ListWithCount[]> {
  const rows = await db
    .select()
    .from(lists)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, lists.id)))
    .orderBy(...orderByWindow(window, lists.id))
    .limit(window.fetchLimit)

  const counts = await countMembersFor(db, rows.map((row) => row.id))

  return rows.map((row) => ({ ...row, memberCount: counts.get(row.id) ?? 0 }))
}

async function countMembersFor(
  db: Queryable,
  listIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (listIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ listId: listMembers.listId, count: sql<number>`count(*)::int` })
    .from(listMembers)
    .where(inArray(listMembers.listId, [...listIds]))
    .groupBy(listMembers.listId)

  return new Map(rows.map((row) => [row.listId, Number(row.count)]))
}

export async function findList(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<ListWithCount | undefined> {
  const [found] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.workspaceId, workspaceId), eq(lists.id, id)))
    .limit(1)

  if (found === undefined) {
    return undefined
  }

  return { ...found, memberCount: await countMembers(db, id) }
}

async function countMembers(db: Queryable, listId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(listMembers)
    .where(eq(listMembers.listId, listId))

  return Number(row?.count ?? 0)
}

export async function insertList(db: Queryable, values: ListColumns): Promise<ListRecord> {
  const [created] = await db.insert(lists).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting list ${values.id} returned no row`)
  }

  return created
}

export async function updateList(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<ListColumns>,
): Promise<ListRecord | undefined> {
  const [updated] = await db
    .update(lists)
    .set(changes)
    .where(and(eq(lists.workspaceId, workspaceId), eq(lists.id, id)))
    .returning()

  return updated
}

export async function deleteList(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(lists)
    .where(and(eq(lists.workspaceId, workspaceId), eq(lists.id, id)))
    .returning({ id: lists.id })

  return deleted.length
}

/** Members: no cursor pagination yet. A list's members render on one page today. */

export const LIST_MEMBER_SORTS: SortableFields<ListMemberRecord> = {
  added_at: timestampSort(listMembers.addedAt, (row) => row.addedAt),
}

export const DEFAULT_LIST_MEMBER_SORT = '-added_at'

export interface ListMemberFilters {
  readonly listId: string
  readonly targetType?: RecordTargetType | undefined
}

function memberConditionsFor(
  workspaceId: string,
  filters: ListMemberFilters,
): (SQL | undefined)[] {
  const targetType = filters.targetType

  return [
    eq(listMembers.workspaceId, workspaceId),
    eq(listMembers.listId, filters.listId),
    targetType === undefined ? undefined : eq(listMembers.targetType, targetType),
  ]
}

export function listListMembers(
  db: Queryable,
  workspaceId: string,
  filters: ListMemberFilters,
  window: ListWindow<ListMemberRecord>,
): Promise<ListMemberRecord[]> {
  return db
    .select()
    .from(listMembers)
    .where(and(...memberConditionsFor(workspaceId, filters), keysetCondition(window, listMembers.id)))
    .orderBy(...orderByWindow(window, listMembers.id))
    .limit(window.fetchLimit)
}

export async function findListMember(
  db: Queryable,
  workspaceId: string,
  listId: string,
  id: string,
): Promise<ListMemberRecord | undefined> {
  const [found] = await db
    .select()
    .from(listMembers)
    .where(
      and(
        eq(listMembers.workspaceId, workspaceId),
        eq(listMembers.listId, listId),
        eq(listMembers.id, id),
      ),
    )
    .limit(1)

  return found
}

export async function insertListMember(
  db: Queryable,
  values: ListMemberColumns,
): Promise<ListMemberRecord> {
  const [created] = await db.insert(listMembers).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting list_member ${values.id} returned no row`)
  }

  return created
}

export async function deleteListMember(
  db: Queryable,
  workspaceId: string,
  listId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(listMembers)
    .where(
      and(
        eq(listMembers.workspaceId, workspaceId),
        eq(listMembers.listId, listId),
        eq(listMembers.id, id),
      ),
    )
    .returning({ id: listMembers.id })

  return deleted.length
}

/** A membership row enriched with the list it points at. */
export interface MembershipWithList {
  readonly id: string
  readonly listId: string
  readonly listName: string
  readonly listTargetType: string
  readonly targetType: string
  readonly targetId: string
  readonly addedAt: Date
}

/**
 * "Which lists is this record on?"
 *
 * Ordered by list name so a record's Lists tab reads alphabetically and the
 * order does not shift as memberships are added.
 */
export async function listMembershipsForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<MembershipWithList[]> {
  return db
    .select({
      id: listMembers.id,
      listId: listMembers.listId,
      listName: lists.name,
      listTargetType: lists.targetType,
      targetType: listMembers.targetType,
      targetId: listMembers.targetId,
      addedAt: listMembers.addedAt,
    })
    .from(listMembers)
    .innerJoin(lists, eq(listMembers.listId, lists.id))
    .where(
      and(
        eq(listMembers.workspaceId, workspaceId),
        eq(listMembers.targetType, targetType),
        eq(listMembers.targetId, targetId),
      ),
    )
    .orderBy(lists.name)
}

/**
 * Removes every list membership for one target.
 *
 * The target is polymorphic and carries no foreign key of its own, so nothing
 * in the database deletes these when the target goes. The service that deletes
 * the target calls this inside the same transaction.
 */
export async function deleteMembershipsForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(listMembers)
    .where(
      and(
        eq(listMembers.workspaceId, workspaceId),
        eq(listMembers.targetType, targetType),
        eq(listMembers.targetId, targetId),
      ),
    )
    .returning({ id: listMembers.id })

  return deleted.length
}

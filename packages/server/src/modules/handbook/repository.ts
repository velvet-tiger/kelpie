import { and, asc, eq, ilike, inArray, isNull, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { handbookPages } from './schema.ts'

export type HandbookPageRecord = typeof handbookPages.$inferSelect

/** The writable column shape. The service builds these; nothing else knows the column names. */
export type HandbookPageColumns = typeof handbookPages.$inferInsert

/**
 * `sort_order` is not here, and cannot be: it orders a page among its siblings
 * only, so two pages under different parents share positions and a workspace-wide
 * sort by it would interleave the levels into nonsense. The tree is rebuilt by
 * the caller from `parent_id` and `sort_order`, which is what the mockup's
 * `flattenTree` does.
 */
export const HANDBOOK_PAGE_SORTS: SortableFields<HandbookPageRecord> = {
  title: textSort(handbookPages.title, (page) => page.title),
  created_at: timestampSort(handbookPages.createdAt, (page) => page.createdAt),
  updated_at: timestampSort(handbookPages.updatedAt, (page) => page.updatedAt),
}

/**
 * Alphabetical, not `-created_at` like the CRM resources.
 *
 * A handbook is read, not triaged. Newest-first would open on Agent FAQ and bury
 * About us, and the creation order of the starter pages is an implementation
 * detail of the seed rather than anything a reader asked for.
 */
export const DEFAULT_HANDBOOK_PAGE_SORT = 'title'

export interface HandbookPageFilters {
  /** `?q=`: title and body. A handbook is searched for what it says, not only for what it is called. */
  readonly term?: string | undefined
  /** `?slug=`, repeatable: the stable handle agent tasks name pages by (`agent-tasks.md`). */
  readonly slugs?: readonly string[] | undefined
}

function conditionsFor(workspaceId: string, filters: HandbookPageFilters): (SQL | undefined)[] {
  const pattern = filters.term === undefined ? undefined : containsPattern(filters.term)

  return [
    eq(handbookPages.workspaceId, workspaceId),
    pattern === undefined
      ? undefined
      : or(ilike(handbookPages.title, pattern), ilike(handbookPages.body, pattern)),
    filters.slugs === undefined ? undefined : inArray(handbookPages.slug, filters.slugs),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listPages(
  db: Queryable,
  workspaceId: string,
  filters: HandbookPageFilters,
  window: ListWindow<HandbookPageRecord>,
): Promise<HandbookPageRecord[]> {
  return db
    .select()
    .from(handbookPages)
    .where(
      and(...conditionsFor(workspaceId, filters), keysetCondition(window, handbookPages.id)),
    )
    .orderBy(...orderByWindow(window, handbookPages.id))
    .limit(window.fetchLimit)
}

export async function findPage(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<HandbookPageRecord | undefined> {
  const [found] = await db
    .select()
    .from(handbookPages)
    .where(and(eq(handbookPages.workspaceId, workspaceId), eq(handbookPages.id, id)))
    .limit(1)

  return found
}

/**
 * Every page in the workspace, in sibling order.
 *
 * The tree rules (depth, no-descendant-cycles, sibling renumbering) all need the
 * whole tree, and a workspace handbook is small enough to walk in memory. Reading
 * it once beats one query per level, and inside a transaction it is the snapshot
 * every check in that transaction agrees on.
 */
export function listAllPages(
  db: Queryable,
  workspaceId: string,
): Promise<HandbookPageRecord[]> {
  return db
    .select()
    .from(handbookPages)
    .where(eq(handbookPages.workspaceId, workspaceId))
    .orderBy(asc(handbookPages.sortOrder), asc(handbookPages.id))
}

/** One parent's children, in board order. Used to renumber a sibling set after a move or a delete. */
export function listChildren(
  db: Queryable,
  workspaceId: string,
  parentId: string | null,
): Promise<HandbookPageRecord[]> {
  return db
    .select()
    .from(handbookPages)
    .where(
      and(
        eq(handbookPages.workspaceId, workspaceId),
        parentId === null ? isNull(handbookPages.parentId) : eq(handbookPages.parentId, parentId),
      ),
    )
    .orderBy(asc(handbookPages.sortOrder), asc(handbookPages.id))
}

/** The slugs already taken in this workspace, for deriving a unique one from a title. */
export async function listSlugs(db: Queryable, workspaceId: string): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ slug: handbookPages.slug })
    .from(handbookPages)
    .where(eq(handbookPages.workspaceId, workspaceId))

  return new Set(rows.map((row) => row.slug))
}

export async function insertPage(
  db: Queryable,
  values: HandbookPageColumns,
): Promise<HandbookPageRecord> {
  const [created] = await db.insert(handbookPages).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting handbook page ${values.id} returned no row`)
  }

  return created
}

export async function updatePage(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<HandbookPageColumns>,
): Promise<HandbookPageRecord | undefined> {
  const [updated] = await db
    .update(handbookPages)
    .set(changes)
    .where(and(eq(handbookPages.workspaceId, workspaceId), eq(handbookPages.id, id)))
    .returning()

  return updated
}

/**
 * Deletes one page. The self-referencing foreign key is `on delete cascade`, so
 * the subtree goes with it without this function naming a single descendant.
 */
export async function deletePage(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(handbookPages)
    .where(and(eq(handbookPages.workspaceId, workspaceId), eq(handbookPages.id, id)))
    .returning({ id: handbookPages.id })

  return deleted.length
}

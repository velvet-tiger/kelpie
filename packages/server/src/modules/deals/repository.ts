import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { anyPersonLinked } from '../personLinks.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { deals } from './schema.ts'

export type DealRecord = typeof deals.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type DealColumns = typeof deals.$inferInsert

/** The sort fields `?sort=` documents for deals. Nullable columns (value, close date) stay out: a keyset cannot seek past a null. */
export const DEAL_SORTS: SortableFields<DealRecord> = {
  name: textSort(deals.name, (deal) => deal.name),
  created_at: timestampSort(deals.createdAt, (deal) => deal.createdAt),
  updated_at: timestampSort(deals.updatedAt, (deal) => deal.updatedAt),
}

export const DEFAULT_DEAL_SORT = '-created_at'

export interface DealFilters {
  /** `?q=`: deal name, summary, tags, competitors, or the company's name. */
  readonly term?: string | undefined
  /** `?company_id=`, repeatable. */
  readonly companyIds?: readonly string[] | undefined
  /** `?stage_id=`, repeatable: the board fetches one column with one of these. */
  readonly stageIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: deals any of these people are on. */
  readonly personIds?: readonly string[] | undefined
}

/**
 * The company half of `?q=`. Reads the `companies` *table*, never its
 * repository, the rule set for a filter spanning a relation (`architecture.md`).
 */
function companyNameMatches(pattern: string): SQL {
  return sql`exists (
    select 1
    from ${companies}
    where ${companies.id} = ${deals.companyId}
      and ${companies.workspaceId} = ${deals.workspaceId}
      and ${companies.name} ilike ${pattern}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(deals.name, pattern),
    ilike(deals.summary, pattern),
    arrayContainsPattern(deals.tags, pattern),
    arrayContainsPattern(deals.competitors, pattern),
    companyNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: DealFilters): (SQL | undefined)[] {
  return [
    eq(deals.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.companyIds === undefined ? undefined : inArray(deals.companyId, filters.companyIds),
    filters.stageIds === undefined ? undefined : inArray(deals.stageId, filters.stageIds),
    filters.personIds === undefined
      ? undefined
      : anyPersonLinked('deal', deals.id, deals.workspaceId, filters.personIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listDeals(
  db: Queryable,
  workspaceId: string,
  filters: DealFilters,
  window: ListWindow<DealRecord>,
): Promise<DealRecord[]> {
  return db
    .select()
    .from(deals)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, deals.id)))
    .orderBy(...orderByWindow(window, deals.id))
    .limit(window.fetchLimit)
}

export async function findDeal(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<DealRecord | undefined> {
  const [found] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
    .limit(1)

  return found
}

export async function insertDeal(db: Queryable, values: DealColumns): Promise<DealRecord> {
  const [created] = await db.insert(deals).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting deal ${values.id} returned no row`)
  }

  return created
}

export async function updateDeal(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<DealColumns>,
): Promise<DealRecord | undefined> {
  const [updated] = await db
    .update(deals)
    .set(changes)
    .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
    .returning()

  return updated
}

export async function deleteDeal(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(deals)
    .where(and(eq(deals.workspaceId, workspaceId), eq(deals.id, id)))
    .returning({ id: deals.id })

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

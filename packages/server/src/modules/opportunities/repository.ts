import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { anyPersonLinked } from '../personLinks.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { opportunities } from './schema.ts'

export type OpportunityRecord = typeof opportunities.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type OpportunityColumns = typeof opportunities.$inferInsert

/** The sort fields `?sort=` documents. The nullable close date stays out: a keyset cannot seek past a null. */
export const OPPORTUNITY_SORTS: SortableFields<OpportunityRecord> = {
  name: textSort(opportunities.name, (opportunity) => opportunity.name),
  created_at: timestampSort(opportunities.createdAt, (opportunity) => opportunity.createdAt),
  updated_at: timestampSort(opportunities.updatedAt, (opportunity) => opportunity.updatedAt),
}

export const DEFAULT_OPPORTUNITY_SORT = '-created_at'

export interface OpportunityFilters {
  /** `?q=`: name, kind, summary, tags, or the company's name. */
  readonly term?: string | undefined
  /** `?kind=`, repeatable: kinds are free text, so a match is exact, not fuzzy. */
  readonly kinds?: readonly string[] | undefined
  /** `?company_id=`, repeatable. */
  readonly companyIds?: readonly string[] | undefined
  /** `?stage_id=`, repeatable: the board fetches one column with one of these. */
  readonly stageIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: opportunities any of these people are on. */
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
    where ${companies.id} = ${opportunities.companyId}
      and ${companies.workspaceId} = ${opportunities.workspaceId}
      and ${companies.name} ilike ${pattern}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(opportunities.name, pattern),
    ilike(opportunities.kind, pattern),
    ilike(opportunities.summary, pattern),
    arrayContainsPattern(opportunities.tags, pattern),
    companyNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: OpportunityFilters): (SQL | undefined)[] {
  return [
    eq(opportunities.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.kinds === undefined ? undefined : inArray(opportunities.kind, filters.kinds),
    filters.companyIds === undefined
      ? undefined
      : inArray(opportunities.companyId, filters.companyIds),
    filters.stageIds === undefined ? undefined : inArray(opportunities.stageId, filters.stageIds),
    filters.personIds === undefined
      ? undefined
      : anyPersonLinked(
          'opportunity',
          opportunities.id,
          opportunities.workspaceId,
          filters.personIds,
        ),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listOpportunities(
  db: Queryable,
  workspaceId: string,
  filters: OpportunityFilters,
  window: ListWindow<OpportunityRecord>,
): Promise<OpportunityRecord[]> {
  return db
    .select()
    .from(opportunities)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, opportunities.id)))
    .orderBy(...orderByWindow(window, opportunities.id))
    .limit(window.fetchLimit)
}

export async function findOpportunity(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<OpportunityRecord | undefined> {
  const [found] = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.id, id)))
    .limit(1)

  return found
}

export async function insertOpportunity(
  db: Queryable,
  values: OpportunityColumns,
): Promise<OpportunityRecord> {
  const [created] = await db.insert(opportunities).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting opportunity ${values.id} returned no row`)
  }

  return created
}

export async function updateOpportunity(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<OpportunityColumns>,
): Promise<OpportunityRecord | undefined> {
  const [updated] = await db
    .update(opportunities)
    .set(changes)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.id, id)))
    .returning()

  return updated
}

export async function deleteOpportunity(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(opportunities)
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.id, id)))
    .returning({ id: opportunities.id })

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

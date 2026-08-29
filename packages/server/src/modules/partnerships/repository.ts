import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { anyPersonLinked } from '../personLinks.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { partnerships } from './schema.ts'

export type PartnershipRecord = typeof partnerships.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type PartnershipColumns = typeof partnerships.$inferInsert

/** The sort fields `?sort=` documents. The nullable touchpoint stays out: a keyset cannot seek past a null. */
export const PARTNERSHIP_SORTS: SortableFields<PartnershipRecord> = {
  name: textSort(partnerships.name, (partnership) => partnership.name),
  created_at: timestampSort(partnerships.createdAt, (partnership) => partnership.createdAt),
  updated_at: timestampSort(partnerships.updatedAt, (partnership) => partnership.updatedAt),
}

export const DEFAULT_PARTNERSHIP_SORT = '-created_at'

export interface PartnershipFilters {
  /** `?q=`: name, kind, summary, tags, or the company's name. */
  readonly term?: string | undefined
  /** `?kind=`, repeatable: kinds are free text, so a match is exact, not fuzzy. */
  readonly kinds?: readonly string[] | undefined
  /** `?company_id=`, repeatable. */
  readonly companyIds?: readonly string[] | undefined
  /** `?stage_id=`, repeatable: the board fetches one column with one of these. */
  readonly stageIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: partnerships any of these people are on. */
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
    where ${companies.id} = ${partnerships.companyId}
      and ${companies.workspaceId} = ${partnerships.workspaceId}
      and ${companies.name} ilike ${pattern}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(partnerships.name, pattern),
    ilike(partnerships.kind, pattern),
    ilike(partnerships.summary, pattern),
    arrayContainsPattern(partnerships.tags, pattern),
    companyNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: PartnershipFilters): (SQL | undefined)[] {
  return [
    eq(partnerships.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.kinds === undefined ? undefined : inArray(partnerships.kind, filters.kinds),
    filters.companyIds === undefined
      ? undefined
      : inArray(partnerships.companyId, filters.companyIds),
    filters.stageIds === undefined ? undefined : inArray(partnerships.stageId, filters.stageIds),
    filters.personIds === undefined
      ? undefined
      : anyPersonLinked('partnership', partnerships.id, partnerships.workspaceId, filters.personIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listPartnerships(
  db: Queryable,
  workspaceId: string,
  filters: PartnershipFilters,
  window: ListWindow<PartnershipRecord>,
): Promise<PartnershipRecord[]> {
  return db
    .select()
    .from(partnerships)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, partnerships.id)))
    .orderBy(...orderByWindow(window, partnerships.id))
    .limit(window.fetchLimit)
}

export async function findPartnership(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<PartnershipRecord | undefined> {
  const [found] = await db
    .select()
    .from(partnerships)
    .where(and(eq(partnerships.workspaceId, workspaceId), eq(partnerships.id, id)))
    .limit(1)

  return found
}

export async function insertPartnership(
  db: Queryable,
  values: PartnershipColumns,
): Promise<PartnershipRecord> {
  const [created] = await db.insert(partnerships).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting partnership ${values.id} returned no row`)
  }

  return created
}

export async function updatePartnership(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<PartnershipColumns>,
): Promise<PartnershipRecord | undefined> {
  const [updated] = await db
    .update(partnerships)
    .set(changes)
    .where(and(eq(partnerships.workspaceId, workspaceId), eq(partnerships.id, id)))
    .returning()

  return updated
}

export async function deletePartnership(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(partnerships)
    .where(and(eq(partnerships.workspaceId, workspaceId), eq(partnerships.id, id)))
    .returning({ id: partnerships.id })

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

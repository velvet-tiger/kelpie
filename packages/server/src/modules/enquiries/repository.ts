import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { anyPersonLinked } from '../personLinks.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { enquiries } from './schema.ts'

export type EnquiryRecord = typeof enquiries.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type EnquiryColumns = typeof enquiries.$inferInsert

/** The sort fields `?sort=` documents. */
export const ENQUIRY_SORTS: SortableFields<EnquiryRecord> = {
  name: textSort(enquiries.name, (enquiry) => enquiry.name),
  created_at: timestampSort(enquiries.createdAt, (enquiry) => enquiry.createdAt),
  updated_at: timestampSort(enquiries.updatedAt, (enquiry) => enquiry.updatedAt),
}

export const DEFAULT_ENQUIRY_SORT = '-created_at'

export interface EnquiryFilters {
  /** `?q=`: name, source, summary, tags, or the company's name. */
  readonly term?: string | undefined
  /** `?source=`, repeatable: sources are free text, so a match is exact, not fuzzy. */
  readonly sources?: readonly string[] | undefined
  /** `?company_id=`, repeatable. */
  readonly companyIds?: readonly string[] | undefined
  /** `?stage_id=`, repeatable: the board fetches one column with one of these. */
  readonly stageIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: enquiries any of these people are on. */
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
    where ${companies.id} = ${enquiries.companyId}
      and ${companies.workspaceId} = ${enquiries.workspaceId}
      and ${companies.name} ilike ${pattern}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(enquiries.name, pattern),
    ilike(enquiries.source, pattern),
    ilike(enquiries.summary, pattern),
    arrayContainsPattern(enquiries.tags, pattern),
    companyNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: EnquiryFilters): (SQL | undefined)[] {
  return [
    eq(enquiries.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.sources === undefined ? undefined : inArray(enquiries.source, filters.sources),
    filters.companyIds === undefined
      ? undefined
      : inArray(enquiries.companyId, filters.companyIds),
    filters.stageIds === undefined ? undefined : inArray(enquiries.stageId, filters.stageIds),
    filters.personIds === undefined
      ? undefined
      : anyPersonLinked('enquiry', enquiries.id, enquiries.workspaceId, filters.personIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listEnquiries(
  db: Queryable,
  workspaceId: string,
  filters: EnquiryFilters,
  window: ListWindow<EnquiryRecord>,
): Promise<EnquiryRecord[]> {
  return db
    .select()
    .from(enquiries)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, enquiries.id)))
    .orderBy(...orderByWindow(window, enquiries.id))
    .limit(window.fetchLimit)
}

export async function findEnquiry(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<EnquiryRecord | undefined> {
  const [found] = await db
    .select()
    .from(enquiries)
    .where(and(eq(enquiries.workspaceId, workspaceId), eq(enquiries.id, id)))
    .limit(1)

  return found
}

export async function insertEnquiry(
  db: Queryable,
  values: EnquiryColumns,
): Promise<EnquiryRecord> {
  const [created] = await db.insert(enquiries).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting enquiry ${values.id} returned no row`)
  }

  return created
}

export async function updateEnquiry(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<EnquiryColumns>,
): Promise<EnquiryRecord | undefined> {
  const [updated] = await db
    .update(enquiries)
    .set(changes)
    .where(and(eq(enquiries.workspaceId, workspaceId), eq(enquiries.id, id)))
    .returning()

  return updated
}

export async function deleteEnquiry(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(enquiries)
    .where(and(eq(enquiries.workspaceId, workspaceId), eq(enquiries.id, id)))
    .returning({ id: enquiries.id })

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

import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { positions } from '../positions/schema.ts'
import { companies } from './schema.ts'

export type CompanyRecord = typeof companies.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type CompanyColumns = typeof companies.$inferInsert

/** The sort fields `?sort=` documents for companies. Nullable columns stay out: a keyset cannot seek past a null. */
export const COMPANY_SORTS: SortableFields<CompanyRecord> = {
  name: textSort(companies.name, (company) => company.name),
  created_at: timestampSort(companies.createdAt, (company) => company.createdAt),
  updated_at: timestampSort(companies.updatedAt, (company) => company.updatedAt),
}

export const DEFAULT_COMPANY_SORT = '-created_at'

export interface CompanyFilters {
  /** `?q=`, matched the way the mockup's Companies filter matches. */
  readonly term?: string | undefined
  /** `?person_id=`, repeatable: companies where any of these people holds a position. */
  readonly personIds?: readonly string[] | undefined
  /** `?is_own=true` returns only the workspace's own companies; `false` returns everything else. */
  readonly isOwn?: boolean | undefined
}

/**
 * `api.md` has no `include` expansion, so without this filter a person detail
 * page would fetch the person's positions and then one company per position.
 *
 * Reads the `positions` table, never its repository. See the same note in the
 * people repository.
 */
function employsAnyOf(personIds: readonly string[]): SQL {
  return sql`exists (
    select 1
    from ${positions}
    where ${positions.companyId} = ${companies.id}
      and ${positions.workspaceId} = ${companies.workspaceId}
      and ${inArray(positions.personId, personIds)}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(companies.name, pattern),
    ilike(companies.domain, pattern),
    ilike(companies.industry, pattern),
    ilike(companies.summary, pattern),
    ilike(companies.accountType, pattern),
    arrayContainsPattern(companies.tags, pattern),
  )
}

function conditionsFor(workspaceId: string, filters: CompanyFilters): (SQL | undefined)[] {
  return [
    eq(companies.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.personIds === undefined ? undefined : employsAnyOf(filters.personIds),
    filters.isOwn === undefined ? undefined : eq(companies.isOwn, filters.isOwn),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listCompanies(
  db: Queryable,
  workspaceId: string,
  filters: CompanyFilters,
  window: ListWindow<CompanyRecord>,
): Promise<CompanyRecord[]> {
  return db
    .select()
    .from(companies)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, companies.id)))
    .orderBy(...orderByWindow(window, companies.id))
    .limit(window.fetchLimit)
}

export async function findCompany(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<CompanyRecord | undefined> {
  const [found] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
    .limit(1)

  return found
}

/**
 * The one company in this workspace on a domain. `domain` is unique per
 * workspace and `citext`, so the comparison matches whatever case arrived.
 */
export async function findCompanyByDomain(
  db: Queryable,
  workspaceId: string,
  domain: string,
): Promise<CompanyRecord | undefined> {
  const [found] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.domain, domain)))
    .limit(1)

  return found
}

/**
 * A company matched by name, for a form submit that was given a name and no
 * domain.
 *
 * Names are not unique, so this is a weaker match than the domain one and is
 * only ever tried second (`forms.md` submit rule 4). The oldest row wins, which
 * makes a repeat submission attach to the same company every time rather than
 * following whichever duplicate was edited last.
 *
 * `lower(…) = lower(…)` rather than `ilike`: the name is caller data, and
 * `ilike` would read a `%` or `_` inside it as a wildcard.
 */
export async function findCompanyByName(
  db: Queryable,
  workspaceId: string,
  name: string,
): Promise<CompanyRecord | undefined> {
  const [found] = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.workspaceId, workspaceId),
        sql`lower(${companies.name}) = lower(${sql.param(name, companies.name)})`,
      ),
    )
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(1)

  return found
}

export async function insertCompany(db: Queryable, values: CompanyColumns): Promise<CompanyRecord> {
  const [created] = await db.insert(companies).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting company ${values.id} returned no row`)
  }

  return created
}

export async function updateCompany(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<CompanyColumns>,
): Promise<CompanyRecord | undefined> {
  const [updated] = await db
    .update(companies)
    .set(changes)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
    .returning()

  return updated
}

export async function deleteCompany(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.id, id)))
    .returning({ id: companies.id })

  return deleted.length
}

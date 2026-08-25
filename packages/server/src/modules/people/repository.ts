import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { positions } from '../positions/schema.ts'
import { people } from './schema.ts'

export type PersonRecord = typeof people.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type PersonColumns = typeof people.$inferInsert

/** The sort fields `?sort=` documents for people. Nullable columns stay out: a keyset cannot seek past a null. */
export const PERSON_SORTS: SortableFields<PersonRecord> = {
  name: textSort(people.name, (person) => person.name),
  created_at: timestampSort(people.createdAt, (person) => person.createdAt),
  updated_at: timestampSort(people.updatedAt, (person) => person.updatedAt),
}

export const DEFAULT_PERSON_SORT = '-created_at'

export interface PersonFilters {
  /** `?q=`, matched the way the mockup's People filter matches. */
  readonly term?: string | undefined
  /** `?company_id=`, repeatable: people holding a position at any of these companies. */
  readonly companyIds?: readonly string[] | undefined
}

/**
 * The position half of `?q=`: a person matches when a title they hold, or the
 * name of a company they hold it at, matches.
 *
 * `architecture.md` keeps repositories inside their own feature, and this reaches
 * across two. It reads the `positions` and `companies` *tables*, never their
 * repositories, which is the same thing every schema file already does. The
 * alternative was three round trips ending in an `in (…)` list of every matching
 * person id, unbounded by the page size. Recorded in `architecture.md`.
 */
function heldPositionMatches(pattern: string): SQL {
  return sql`exists (
    select 1
    from ${positions}
    inner join ${companies} on ${companies.id} = ${positions.companyId}
    where ${positions.personId} = ${people.id}
      and ${positions.workspaceId} = ${people.workspaceId}
      and (${positions.title} ilike ${pattern} or ${companies.name} ilike ${pattern})
  )`
}

function holdsPositionAtAny(companyIds: readonly string[]): SQL {
  return sql`exists (
    select 1
    from ${positions}
    where ${positions.personId} = ${people.id}
      and ${positions.workspaceId} = ${people.workspaceId}
      and ${inArray(positions.companyId, companyIds)}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(people.name, pattern),
    ilike(people.email, pattern),
    ilike(people.summary, pattern),
    arrayContainsPattern(people.tags, pattern),
    heldPositionMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: PersonFilters): (SQL | undefined)[] {
  return [
    eq(people.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.companyIds === undefined ? undefined : holdsPositionAtAny(filters.companyIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listPeople(
  db: Queryable,
  workspaceId: string,
  filters: PersonFilters,
  window: ListWindow<PersonRecord>,
): Promise<PersonRecord[]> {
  return db
    .select()
    .from(people)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, people.id)))
    .orderBy(...orderByWindow(window, people.id))
    .limit(window.fetchLimit)
}

export async function findPerson(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<PersonRecord | undefined> {
  const [found] = await db
    .select()
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
    .limit(1)

  return found
}

/**
 * The one person in this workspace holding an address, for the upsert a form
 * submit does.
 *
 * `email` is unique per workspace and the column is `citext`, so the comparison
 * matches whatever case arrived. Callers still normalise first; the column type
 * is the second line of defence described in `lib/normalisation.ts`.
 */
export async function findPersonByEmail(
  db: Queryable,
  workspaceId: string,
  email: string,
): Promise<PersonRecord | undefined> {
  const [found] = await db
    .select()
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.email, email)))
    .limit(1)

  return found
}

/**
 * Every person in this workspace whose email is exactly at `domain`, case-
 * insensitive. Used by the email-domain auto-linker when a Company is created
 * or its domain is set.
 *
 * Not `ilike '%@domain'`: that also matches `alex@sub.domain`, which the
 * person-side matcher (exact `email.slice(at + 1) = companies.domain`) would
 * never link. `split_part` peels off the address at the last `@`, keeping the
 * two directions consistent.
 */
export async function findPeopleByEmailDomain(
  db: Queryable,
  workspaceId: string,
  domain: string,
): Promise<PersonRecord[]> {
  return db
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspaceId, workspaceId),
        sql`split_part(${people.email}::text, '@', 2) = lower(${domain})`,
      ),
    )
}

export async function insertPerson(db: Queryable, values: PersonColumns): Promise<PersonRecord> {
  const [created] = await db.insert(people).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting person ${values.id} returned no row`)
  }

  return created
}

export async function updatePerson(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<PersonColumns>,
): Promise<PersonRecord | undefined> {
  const [updated] = await db
    .update(people)
    .set(changes)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
    .returning()

  return updated
}

export async function deletePerson(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.id, id)))
    .returning({ id: people.id })

  return deleted.length
}

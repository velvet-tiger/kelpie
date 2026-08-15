import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { arrayContainsPattern, containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { people } from '../people/schema.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { raisePeople, raises } from './schema.ts'

export type RaiseRecord = typeof raises.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type RaiseColumns = typeof raises.$inferInsert

/**
 * The sort fields `?sort=` documents. Check size and target close stay out: both
 * are nullable, and a keyset cannot seek past a null.
 */
export const RAISE_SORTS: SortableFields<RaiseRecord> = {
  name: textSort(raises.name, (raise) => raise.name),
  created_at: timestampSort(raises.createdAt, (raise) => raise.createdAt),
  updated_at: timestampSort(raises.updatedAt, (raise) => raise.updatedAt),
}

export const DEFAULT_RAISE_SORT = '-created_at'

export interface RaiseFilters {
  /** `?q=`: name, summary, tags, or the firm's name. */
  readonly term?: string | undefined
  /** `?company_id=`, repeatable: the firm. */
  readonly companyIds?: readonly string[] | undefined
  /** `?stage_id=`, repeatable: the board fetches one column with one of these. */
  readonly stageIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: raises any of these people are key on. */
  readonly personIds?: readonly string[] | undefined
}

/**
 * The firm half of `?q=`. Reads the `companies` *table*, never its repository,
 * the rule set for a filter spanning a relation (`architecture.md`).
 */
function companyNameMatches(pattern: string): SQL {
  return sql`exists (
    select 1
    from ${companies}
    where ${companies.id} = ${raises.companyId}
      and ${companies.workspaceId} = ${raises.workspaceId}
      and ${companies.name} ilike ${pattern}
  )`
}

function hasAnyOfPeople(personIds: readonly string[]): SQL {
  return sql`exists (
    select 1
    from ${raisePeople}
    where ${raisePeople.raiseId} = ${raises.id}
      and ${inArray(raisePeople.personId, personIds)}
  )`
}

function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(raises.name, pattern),
    ilike(raises.summary, pattern),
    arrayContainsPattern(raises.tags, pattern),
    companyNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: RaiseFilters): (SQL | undefined)[] {
  return [
    eq(raises.workspaceId, workspaceId),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
    filters.companyIds === undefined ? undefined : inArray(raises.companyId, filters.companyIds),
    filters.stageIds === undefined ? undefined : inArray(raises.stageId, filters.stageIds),
    filters.personIds === undefined ? undefined : hasAnyOfPeople(filters.personIds),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listRaises(
  db: Queryable,
  workspaceId: string,
  filters: RaiseFilters,
  window: ListWindow<RaiseRecord>,
): Promise<RaiseRecord[]> {
  return db
    .select()
    .from(raises)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, raises.id)))
    .orderBy(...orderByWindow(window, raises.id))
    .limit(window.fetchLimit)
}

export async function findRaise(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<RaiseRecord | undefined> {
  const [found] = await db
    .select()
    .from(raises)
    .where(and(eq(raises.workspaceId, workspaceId), eq(raises.id, id)))
    .limit(1)

  return found
}

export async function insertRaise(db: Queryable, values: RaiseColumns): Promise<RaiseRecord> {
  const [created] = await db.insert(raises).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting raise ${values.id} returned no row`)
  }

  return created
}

export async function updateRaise(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<RaiseColumns>,
): Promise<RaiseRecord | undefined> {
  const [updated] = await db
    .update(raises)
    .set(changes)
    .where(and(eq(raises.workspaceId, workspaceId), eq(raises.id, id)))
    .returning()

  return updated
}

export async function deleteRaise(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(raises)
    .where(and(eq(raises.workspaceId, workspaceId), eq(raises.id, id)))
    .returning({ id: raises.id })

  return deleted.length
}

/** The key people on one raise. Ordered by id so a response is stable across reads. */
export async function listPersonIds(db: Queryable, raiseId: string): Promise<string[]> {
  const rows = await db
    .select({ personId: raisePeople.personId })
    .from(raisePeople)
    .where(eq(raisePeople.raiseId, raiseId))
    .orderBy(asc(raisePeople.personId))

  return rows.map((row) => row.personId)
}

/**
 * The key people on each of a page of raises, in one query rather than one per
 * row.
 *
 * @returns Ids missing from the map have no people.
 */
export async function listPersonIdsFor(
  db: Queryable,
  raiseIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (raiseIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ raiseId: raisePeople.raiseId, personId: raisePeople.personId })
    .from(raisePeople)
    .where(inArray(raisePeople.raiseId, raiseIds))
    .orderBy(asc(raisePeople.personId))

  const byRaise = new Map<string, string[]>()

  for (const row of rows) {
    const existing = byRaise.get(row.raiseId)

    if (existing === undefined) {
      byRaise.set(row.raiseId, [row.personId])
    } else {
      existing.push(row.personId)
    }
  }

  return byRaise
}

export async function insertRaisePeople(
  db: Queryable,
  raiseId: string,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) {
    return
  }

  await db.insert(raisePeople).values(personIds.map((personId) => ({ raiseId, personId })))
}

export async function deleteRaisePeople(
  db: Queryable,
  raiseId: string,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) {
    return
  }

  await db
    .delete(raisePeople)
    .where(and(eq(raisePeople.raiseId, raiseId), inArray(raisePeople.personId, personIds)))
}

/**
 * The names of these people in this workspace, keyed by id. An id missing from
 * the map does not exist here, which is how `person_ids` is validated. Reads the
 * `people` *table*, per the cross-relation rule in `architecture.md`.
 */
export async function findPeopleNamed(
  db: Queryable,
  workspaceId: string,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (personIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({ id: people.id, name: people.name })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)))

  return new Map(rows.map((row) => [row.id, row.name]))
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

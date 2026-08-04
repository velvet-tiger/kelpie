import { and, eq, ilike, inArray } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, textSort, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { people } from '../people/schema.ts'
import { candidates, roles } from './schema.ts'

export type RoleRecord = typeof roles.$inferSelect
export type CandidateRecord = typeof candidates.$inferSelect

/** The writable column shapes. Services build these; nothing else knows the column names. */
export type RoleColumns = typeof roles.$inferInsert
export type CandidateColumns = typeof candidates.$inferInsert

export const ROLE_SORTS: SortableFields<RoleRecord> = {
  title: textSort(roles.title, (role) => role.title),
  created_at: timestampSort(roles.createdAt, (role) => role.createdAt),
  updated_at: timestampSort(roles.updatedAt, (role) => role.updatedAt),
}

export const DEFAULT_ROLE_SORT = '-created_at'

export interface RoleFilters {
  /** `?q=`: the title, which is all the mockup's filter box matches on a role. */
  readonly term?: string | undefined
  /** `?status=`, repeatable: open, closed, or both. */
  readonly statuses?: readonly string[] | undefined
}

function roleConditionsFor(workspaceId: string, filters: RoleFilters): (SQL | undefined)[] {
  return [
    eq(roles.workspaceId, workspaceId),
    filters.term === undefined ? undefined : ilike(roles.title, containsPattern(filters.term)),
    filters.statuses === undefined ? undefined : inArray(roles.status, filters.statuses),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listRoles(
  db: Queryable,
  workspaceId: string,
  filters: RoleFilters,
  window: ListWindow<RoleRecord>,
): Promise<RoleRecord[]> {
  return db
    .select()
    .from(roles)
    .where(and(...roleConditionsFor(workspaceId, filters), keysetCondition(window, roles.id)))
    .orderBy(...orderByWindow(window, roles.id))
    .limit(window.fetchLimit)
}

export async function findRole(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<RoleRecord | undefined> {
  const [found] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, id)))
    .limit(1)

  return found
}

export async function insertRole(db: Queryable, values: RoleColumns): Promise<RoleRecord> {
  const [created] = await db.insert(roles).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting role ${values.id} returned no row`)
  }

  return created
}

export async function updateRole(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<RoleColumns>,
): Promise<RoleRecord | undefined> {
  const [updated] = await db
    .update(roles)
    .set(changes)
    .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, id)))
    .returning()

  return updated
}

export async function deleteRole(db: Queryable, workspaceId: string, id: string): Promise<number> {
  const deleted = await db
    .delete(roles)
    .where(and(eq(roles.workspaceId, workspaceId), eq(roles.id, id)))
    .returning({ id: roles.id })

  return deleted.length
}

/**
 * No `title` sort and no `?q=`. A candidacy holds no text of its own; the name a
 * reader sorts or searches by belongs to the person on the far side of the link.
 */
export const CANDIDATE_SORTS: SortableFields<CandidateRecord> = {
  created_at: timestampSort(candidates.createdAt, (candidate) => candidate.createdAt),
  updated_at: timestampSort(candidates.updatedAt, (candidate) => candidate.updatedAt),
}

export const DEFAULT_CANDIDATE_SORT = '-created_at'

export interface CandidateFilters {
  /** `?role_id=`, repeatable: one role's pipeline, or a page of roles' counts. */
  readonly roleIds?: readonly string[] | undefined
  /** `?person_id=`, repeatable: every role a person is up for. */
  readonly personIds?: readonly string[] | undefined
  /** `?status=`, repeatable: the pipeline state this record exists to hold. */
  readonly statuses?: readonly string[] | undefined
}

function candidateConditionsFor(
  workspaceId: string,
  filters: CandidateFilters,
): (SQL | undefined)[] {
  return [
    eq(candidates.workspaceId, workspaceId),
    filters.roleIds === undefined ? undefined : inArray(candidates.roleId, filters.roleIds),
    filters.personIds === undefined ? undefined : inArray(candidates.personId, filters.personIds),
    filters.statuses === undefined ? undefined : inArray(candidates.status, filters.statuses),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listCandidates(
  db: Queryable,
  workspaceId: string,
  filters: CandidateFilters,
  window: ListWindow<CandidateRecord>,
): Promise<CandidateRecord[]> {
  return db
    .select()
    .from(candidates)
    .where(
      and(
        ...candidateConditionsFor(workspaceId, filters),
        keysetCondition(window, candidates.id),
      ),
    )
    .orderBy(...orderByWindow(window, candidates.id))
    .limit(window.fetchLimit)
}

export async function findCandidate(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<CandidateRecord | undefined> {
  const [found] = await db
    .select()
    .from(candidates)
    .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.id, id)))
    .limit(1)

  return found
}

/** Every candidacy on one role, for the cascade its delete performs. */
export function listCandidatesOfRole(
  db: Queryable,
  workspaceId: string,
  roleId: string,
): Promise<CandidateRecord[]> {
  return db
    .select()
    .from(candidates)
    .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.roleId, roleId)))
}

export async function insertCandidate(
  db: Queryable,
  values: CandidateColumns,
): Promise<CandidateRecord> {
  const [created] = await db.insert(candidates).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting candidate ${values.id} returned no row`)
  }

  return created
}

export async function updateCandidate(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<CandidateColumns>,
): Promise<CandidateRecord | undefined> {
  const [updated] = await db
    .update(candidates)
    .set(changes)
    .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.id, id)))
    .returning()

  return updated
}

export async function deleteCandidate(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(candidates)
    .where(and(eq(candidates.workspaceId, workspaceId), eq(candidates.id, id)))
    .returning({ id: candidates.id })

  return deleted.length
}

/**
 * The names of these people in this workspace, keyed by id. An id missing from
 * the map does not exist here, which is how `person_id` and `referrer_person_id`
 * are validated. Reads the `people` *table*, per the cross-relation rule in
 * `architecture.md`.
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

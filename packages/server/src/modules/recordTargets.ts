import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { Queryable } from '../runtime/transaction.ts'
import { companies } from './companies/schema.ts'
import { deals } from './deals/schema.ts'
import { enquiries } from './enquiries/schema.ts'
import { candidates } from './hiring/schema.ts'
import { RECORD_TARGET_TYPES } from './notes/schema.ts'
import { opportunities } from './opportunities/schema.ts'
import { partnerships } from './partnerships/schema.ts'
import { people } from './people/schema.ts'
import { raises } from './raises/schema.ts'

/**
 * Resolving a polymorphic `target_type` + `target_id` to the record it names.
 *
 * Notes and activities carry no foreign key to their target, so nothing in the
 * database refuses a note attached to an id that does not exist, or to one that
 * belongs to another workspace. This is where that is refused instead.
 *
 * Reading seven modules' tables rather than composing seven repositories is the
 * rule already set for a filter that spans a relation (`architecture.md`): the
 * alternative here is a switch that imports seven services to ask each of them
 * one boolean.
 */

export type RecordTargetType = (typeof RECORD_TARGET_TYPES)[number]

interface TargetTable {
  readonly table: PgTable
  readonly id: PgColumn
  readonly workspaceId: PgColumn
  /**
   * The column holding the record's display name, absent when the record has no
   * name of its own. A Candidate is the only such type: it is a Person-to-Role
   * link, so what a reader calls it lives on two other rows.
   */
  readonly name?: PgColumn
}

function targetTable(
  table: PgTable,
  id: PgColumn,
  workspaceId: PgColumn,
  name?: PgColumn,
): TargetTable {
  return { table, id, workspaceId, ...(name === undefined ? {} : { name }) }
}

const TABLES: Readonly<Record<RecordTargetType, TargetTable>> = {
  person: targetTable(people, people.id, people.workspaceId, people.name),
  company: targetTable(companies, companies.id, companies.workspaceId, companies.name),
  deal: targetTable(deals, deals.id, deals.workspaceId, deals.name),
  opportunity: targetTable(
    opportunities,
    opportunities.id,
    opportunities.workspaceId,
    opportunities.name,
  ),
  partnership: targetTable(
    partnerships,
    partnerships.id,
    partnerships.workspaceId,
    partnerships.name,
  ),
  raise: targetTable(raises, raises.id, raises.workspaceId, raises.name),
  enquiry: targetTable(enquiries, enquiries.id, enquiries.workspaceId, enquiries.name),
  candidate: targetTable(candidates, candidates.id, candidates.workspaceId),
}

export function isRecordTargetType(value: string): value is RecordTargetType {
  return Object.hasOwn(TABLES, value)
}

/**
 * Which of `targetIds` do not name a record of `targetType` in this workspace.
 *
 * One query however many ids are asked about, which is what lets a list filtered
 * by a set of targets validate them without a round trip per id.
 *
 * @returns The ids that resolved to nothing, in the order they were given. An id
 *   in another workspace is indistinguishable from one that never existed, so it
 *   comes back here too and the caller turns either into the same 404.
 */
export async function missingTargets(
  db: Queryable,
  workspaceId: string,
  targetType: RecordTargetType,
  targetIds: readonly string[],
): Promise<readonly string[]> {
  if (targetIds.length === 0) {
    return []
  }

  const target = TABLES[targetType]
  const found = await db
    .select({ id: target.id })
    .from(target.table)
    .where(and(eq(target.workspaceId, workspaceId), inArray(target.id, [...targetIds])))

  const existing = new Set(found.map((row) => row.id))

  return targetIds.filter((id) => !existing.has(id))
}

/**
 * Whether a target exists inside one workspace.
 *
 * @returns false both for a target that never existed and for one in another
 *   workspace. The caller turns either into the same 404, per `api.md`.
 */
export async function targetExists(
  db: Queryable,
  workspaceId: string,
  targetType: RecordTargetType,
  targetId: string,
): Promise<boolean> {
  return (await missingTargets(db, workspaceId, targetType, [targetId])).length === 0
}

/** A polymorphic reference, as notes, activities, decisions and plan items carry one. */
export interface RecordTarget {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

/** The key `resolveTargetNames` returns names under. Type and id together, because ids are unique only within a type. */
export function targetKey(target: RecordTarget): string {
  return `${target.targetType}:${target.targetId}`
}

async function namesOfType(
  db: Queryable,
  workspaceId: string,
  targetType: RecordTargetType,
  targetIds: readonly string[],
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  const target = TABLES[targetType]

  // A Candidate's label is the person's name. The role it is for is the other
  // half of the answer, but a timeline row already says which record it is on,
  // so repeating the title in the name would read as "Ada Lovelace" twice over.
  if (target.name === undefined) {
    return db
      .select({ id: candidates.id, name: people.name })
      .from(candidates)
      .innerJoin(people, eq(candidates.personId, people.id))
      .where(and(eq(candidates.workspaceId, workspaceId), inArray(candidates.id, [...targetIds])))
  }

  // `sql<string>` rather than the columns alone: `TargetTable` holds them as the
  // generic `PgColumn`, whose data type is `unknown`, so a plain select of one
  // widens the result. Both are `text` columns in every table above.
  return db
    .select({ id: sql<string>`${target.id}`, name: sql<string>`${target.name}` })
    .from(target.table)
    .where(and(eq(target.workspaceId, workspaceId), inArray(target.id, [...targetIds])))
}

/**
 * What to call each of a mixed set of records.
 *
 * One query per distinct type however many ids are asked about, which is what
 * lets a cross-record list name its rows without a request per row. A page
 * showing one record's own notes has no use for this; a workspace-wide feed,
 * where every row points somewhere different, cannot render without it.
 *
 * @returns Names keyed by `targetKey`. A target that resolved to nothing is
 *   absent rather than present as a placeholder, so a caller decides for itself
 *   whether to render the type alone or drop the row.
 */
export async function resolveTargetNames(
  db: Queryable,
  workspaceId: string,
  targets: readonly RecordTarget[],
): Promise<ReadonlyMap<string, string>> {
  const idsByType = new Map<RecordTargetType, Set<string>>()

  for (const target of targets) {
    const ids = idsByType.get(target.targetType) ?? new Set<string>()

    ids.add(target.targetId)
    idsByType.set(target.targetType, ids)
  }

  const names = new Map<string, string>()

  for (const [targetType, ids] of idsByType) {
    for (const row of await namesOfType(db, workspaceId, targetType, [...ids])) {
      names.set(targetKey({ targetType, targetId: row.id }), row.name)
    }
  }

  return names
}

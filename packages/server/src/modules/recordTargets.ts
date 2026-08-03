import { and, eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { Queryable } from '../runtime/transaction.ts'
import { companies } from './companies/schema.ts'
import { deals } from './deals/schema.ts'
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
}

function targetTable(table: PgTable, id: PgColumn, workspaceId: PgColumn): TargetTable {
  return { table, id, workspaceId }
}

const TABLES: Readonly<Record<RecordTargetType, TargetTable>> = {
  person: targetTable(people, people.id, people.workspaceId),
  company: targetTable(companies, companies.id, companies.workspaceId),
  deal: targetTable(deals, deals.id, deals.workspaceId),
  opportunity: targetTable(opportunities, opportunities.id, opportunities.workspaceId),
  partnership: targetTable(partnerships, partnerships.id, partnerships.workspaceId),
  raise: targetTable(raises, raises.id, raises.workspaceId),
  candidate: targetTable(candidates, candidates.id, candidates.workspaceId),
}

export function isRecordTargetType(value: string): value is RecordTargetType {
  return Object.hasOwn(TABLES, value)
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
  const target = TABLES[targetType]
  const [found] = await db
    .select({ id: target.id })
    .from(target.table)
    .where(and(eq(target.workspaceId, workspaceId), eq(target.id, targetId)))
    .limit(1)

  return found !== undefined
}

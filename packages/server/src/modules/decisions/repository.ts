import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { raises } from '../raises/schema.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { decisions } from './schema.ts'
import type { RecordTargetType } from './schema.ts'

export type DecisionRecord = typeof decisions.$inferSelect

/** The writable column shape. Services build one of these; nothing else knows the column names. */
export type DecisionColumns = typeof decisions.$inferInsert

export const DECISION_SORTS: SortableFields<DecisionRecord> = {
  decided_at: timestampSort(decisions.decidedAt, (decision) => decision.decidedAt),
  created_at: timestampSort(decisions.createdAt, (decision) => decision.createdAt),
  updated_at: timestampSort(decisions.updatedAt, (decision) => decision.updatedAt),
}

/**
 * The workspace list answers "what have we committed to lately", so the most
 * recent decision leads. `due_at` is nullable, and a keyset cannot seek past a
 * null, so it is not a sort.
 */
export const DEFAULT_DECISION_SORT = '-decided_at'

export interface DecisionFilters {
  /** `?target_type=`. On its own it lists every decision on that kind of record. */
  readonly targetType?: RecordTargetType | undefined
  /** `?target_id=`, repeatable: a panel asks with one, a roll-up with a set. */
  readonly targetIds?: readonly string[] | undefined
  readonly term?: string | undefined
}

/**
 * The target tables `?q=` can name a record in. Ids join without a type gate
 * because every id carries its prefix and matches at most one table.
 *
 * Candidate is missing: its label is the person behind the candidacy, two joins
 * away, so a candidate-targeted decision matches on body and rationale only.
 */
const NAMED_TARGET_TABLES = [
  { table: people, id: people.id, workspaceId: people.workspaceId, name: people.name },
  { table: companies, id: companies.id, workspaceId: companies.workspaceId, name: companies.name },
  { table: deals, id: deals.id, workspaceId: deals.workspaceId, name: deals.name },
  { table: opportunities, id: opportunities.id, workspaceId: opportunities.workspaceId, name: opportunities.name },
  { table: partnerships, id: partnerships.id, workspaceId: partnerships.workspaceId, name: partnerships.name },
  { table: raises, id: raises.id, workspaceId: raises.workspaceId, name: raises.name },
  { table: enquiries, id: enquiries.id, workspaceId: enquiries.workspaceId, name: enquiries.name },
]

/**
 * The target-name half of `?q=`. Reads the other modules' *tables*, never their
 * repositories, the rule set for a filter spanning a relation
 * (`architecture.md`).
 */
function targetNameMatches(pattern: string): SQL[] {
  return NAMED_TARGET_TABLES.map(
    ({ table, id, workspaceId, name }) => sql`exists (
      select 1
      from ${table}
      where ${id} = ${decisions.targetId}
        and ${workspaceId} = ${decisions.workspaceId}
        and ${name} ilike ${pattern}
    )`,
  )
}

/** The fields the mockup's decisions `FilterBar` matches: body, rationale, target type, target name. */
function matchesTerm(term: string): SQL | undefined {
  const pattern = containsPattern(term)

  return or(
    ilike(decisions.body, pattern),
    ilike(decisions.rationale, pattern),
    ilike(decisions.targetType, pattern),
    ...targetNameMatches(pattern),
  )
}

function conditionsFor(workspaceId: string, filters: DecisionFilters): (SQL | undefined)[] {
  return [
    eq(decisions.workspaceId, workspaceId),
    filters.targetType === undefined ? undefined : eq(decisions.targetType, filters.targetType),
    filters.targetIds === undefined ? undefined : inArray(decisions.targetId, filters.targetIds),
    filters.term === undefined ? undefined : matchesTerm(filters.term),
  ]
}

/** @returns Up to `window.fetchLimit` rows: one more than the page, so the caller can tell there is a next one. */
export function listDecisions(
  db: Queryable,
  workspaceId: string,
  filters: DecisionFilters,
  window: ListWindow<DecisionRecord>,
): Promise<DecisionRecord[]> {
  return db
    .select()
    .from(decisions)
    .where(and(...conditionsFor(workspaceId, filters), keysetCondition(window, decisions.id)))
    .orderBy(...orderByWindow(window, decisions.id))
    .limit(window.fetchLimit)
}

export async function findDecision(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<DecisionRecord | undefined> {
  const [found] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, id)))
    .limit(1)

  return found
}

export async function insertDecision(db: Queryable, values: DecisionColumns): Promise<DecisionRecord> {
  const [created] = await db.insert(decisions).values(values).returning()

  if (created === undefined) {
    throw new Error(`Inserting decision ${values.id} returned no row`)
  }

  return created
}

export async function updateDecision(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: Partial<DecisionColumns>,
): Promise<DecisionRecord | undefined> {
  const [updated] = await db
    .update(decisions)
    .set(changes)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, id)))
    .returning()

  return updated
}

export async function deleteDecision(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<number> {
  const deleted = await db
    .delete(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, id)))
    .returning({ id: decisions.id })

  return deleted.length
}

/**
 * Removes every decision attached to a target.
 *
 * The target is polymorphic and carries no foreign key, so nothing in the
 * database deletes these. The service that deletes the target calls this inside
 * the same transaction (`schema.md`).
 */
export async function deleteForTarget(
  db: Queryable,
  workspaceId: string,
  targetType: string,
  targetId: string,
): Promise<number> {
  const deleted = await db
    .delete(decisions)
    .where(
      and(
        eq(decisions.workspaceId, workspaceId),
        eq(decisions.targetType, targetType),
        eq(decisions.targetId, targetId),
      ),
    )
    .returning({ id: decisions.id })

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

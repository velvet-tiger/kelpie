import { and, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'
import { containsPattern } from '../../lib/search.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { companies } from '../companies/schema.ts'
import { deals } from '../deals/schema.ts'
import { enquiries } from '../enquiries/schema.ts'
import { events } from '../events/schema.ts'
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
  /**
   * `?confirmed=`. True lists commitments, false lists proposals that no member
   * has confirmed. Absent returns both.
   */
  readonly confirmed?: boolean | undefined
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
  { table: events, id: events.id, workspaceId: events.workspaceId, name: events.name },
]

/**
 * The target-name half of `?q=`. Reads the other modules' *tables*, never their
 * repositories, the rule set for a filter spanning a relation.
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
    filters.confirmed === undefined
      ? undefined
      : filters.confirmed
        ? isNotNull(decisions.confirmedAt)
        : isNull(decisions.confirmedAt),
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

/**
 * A decision, read with a lock on its row until the transaction ends. A
 * confirm and another update wait for that lock, so what the caller reads
 * here is still the row when the caller's own write lands.
 *
 * @returns Undefined when the decision is not in the workspace.
 */
export async function lockDecision(
  tx: Queryable,
  workspaceId: string,
  id: string,
): Promise<DecisionRecord | undefined> {
  const [found] = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, id)))
    .limit(1)
    .for('update')

  return found
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

/**
 * Confirms a decision that is still a proposal.
 *
 * The `confirmed_at is null` term makes the write safe to repeat: a second
 * call, or one that lost a race, changes nothing and gets no row back, so the
 * first confirmation keeps its time and its member.
 *
 * `expectedUpdatedAt`, when given, is part of the same statement, so an edit
 * that lands between the caller's read and this write cannot be confirmed by
 * it. The column holds microseconds and the wire carries milliseconds, so
 * the comparison is at the millisecond.
 *
 * @returns The confirmed row, or undefined when the decision is not in this
 *   workspace, was confirmed already, or is not the expected version.
 */
export async function confirmDecision(
  db: Queryable,
  workspaceId: string,
  id: string,
  confirmation: { readonly confirmedAt: Date; readonly confirmedById: string; readonly updatedAt: Date },
  expectedUpdatedAt: Date | undefined,
): Promise<DecisionRecord | undefined> {
  const [confirmed] = await db
    .update(decisions)
    .set(confirmation)
    .where(
      and(
        eq(decisions.workspaceId, workspaceId),
        eq(decisions.id, id),
        isNull(decisions.confirmedAt),
        expectedUpdatedAt === undefined
          ? undefined
          : sql`date_trunc('milliseconds', ${decisions.updatedAt}) = ${expectedUpdatedAt.toISOString()}::timestamptz`,
      ),
    )
    .returning()

  return confirmed
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
 * the same transaction.
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

/** Moves every decision from one target to another inside a conversion transaction. */
export async function repointForTarget(
  db: Queryable,
  workspaceId: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
): Promise<number> {
  const updated = await db
    .update(decisions)
    .set({ targetType: toType, targetId: toId })
    .where(
      and(
        eq(decisions.workspaceId, workspaceId),
        eq(decisions.targetType, fromType),
        eq(decisions.targetId, fromId),
      ),
    )
    .returning({ id: decisions.id })

  return updated.length
}
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

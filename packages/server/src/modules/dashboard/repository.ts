import { OPEN_PLAN_ITEM_STATUSES, PIPELINE_KINDS } from '@kelpie/schemas'
import type { PipelineKind } from '@kelpie/schemas'
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { Queryable } from '../../runtime/transaction.ts'
import { activities } from '../activities/schema.ts'
import { decisions } from '../decisions/schema.ts'
import { deals } from '../deals/schema.ts'
import { notes } from '../notes/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { partnerships } from '../partnerships/schema.ts'
import { people } from '../people/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { planItems } from '../plans/schema.ts'
import { raises } from '../raises/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The reads behind `GET /v1/dashboard`.
 *
 * Ten tables, no repository imports. Composing ten other modules' repositories
 * would mean asking each of them for a page and counting it here, which is the
 * one thing `architecture.md` says a repository may cross a module boundary to
 * avoid: schema imports already cross everywhere, repository imports still do
 * not.
 *
 * Every signal is a count and a list rather than a list the caller measures. A
 * capped list cannot answer "how many", and a workspace with two hundred overdue
 * steps should say so without sending two hundred rows to a page showing four.
 */

export type PlanItemRecord = typeof planItems.$inferSelect
export type ActivityRecord = typeof activities.$inferSelect
export type NoteRecord = typeof notes.$inferSelect
export type DecisionRecord = typeof decisions.$inferSelect

/** A partnership whose next touchpoint is at hand. `nextTouchpoint` is never null in this shape. */
export interface TouchpointRecord {
  readonly id: string
  readonly name: string
  readonly companyId: string
  readonly nextTouchpoint: string
  readonly ownerId: string | null
  readonly summary: string
}

/** A person nobody has spoken to lately. */
export interface StaleContactRecord {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly lastContactedAt: Date
  /** The calendar day of `lastContactedAt` in the workspace's zone, `YYYY-MM-DD`. */
  readonly lastContactedDay: string
  readonly summary: string
}

/**
 * The workspace's IANA zone, which is what decides the day its dates are read
 * against.
 *
 * @returns undefined when the workspace does not exist. The caller has an actor
 *   bound to it, so that means it was deleted mid-request.
 */
export async function findWorkspaceTimezone(
  db: Queryable,
  workspaceId: string,
): Promise<string | undefined> {
  const [found] = await db
    .select({ timezone: workspaces.timezone })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)

  return found?.timezone
}

interface PipelineTable {
  readonly table: PgTable
  readonly workspaceId: PgColumn
  readonly stageId: PgColumn
}

function pipelineTable(table: PgTable, workspaceId: PgColumn, stageId: PgColumn): PipelineTable {
  return { table, workspaceId, stageId }
}

/**
 * Which table each pipeline kind lives in. Partnership is a pipeline like the
 * other three: `pipeline_stages.kind` carries all four, and its board columns
 * are configured the same way.
 */
const PIPELINE_TABLES: Readonly<Record<PipelineKind, PipelineTable>> = {
  deal: pipelineTable(deals, deals.workspaceId, deals.stageId),
  opportunity: pipelineTable(opportunities, opportunities.workspaceId, opportunities.stageId),
  raise: pipelineTable(raises, raises.workspaceId, raises.stageId),
  partnership: pipelineTable(partnerships, partnerships.workspaceId, partnerships.stageId),
}

async function countOpenRecords(
  db: Queryable,
  workspaceId: string,
  pipeline: PipelineTable,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(pipeline.table)
    .innerJoin(pipelineStages, eq(pipeline.stageId, pipelineStages.id))
    .where(and(eq(pipeline.workspaceId, workspaceId), eq(pipelineStages.open, true)))

  return row?.total ?? 0
}

/**
 * How many records sit in an open stage, per pipeline.
 *
 * Open is the stage's own `open` flag rather than a list of stage slugs: stages
 * are configurable per workspace, so "not won and not lost" is a rule about one
 * seeded board and not about the column a workspace actually added.
 */
export async function countOpenByPipeline(
  db: Queryable,
  workspaceId: string,
): Promise<Readonly<Record<PipelineKind, number>>> {
  const counts: Partial<Record<PipelineKind, number>> = {}

  for (const kind of PIPELINE_KINDS) {
    counts[kind] = await countOpenRecords(db, workspaceId, PIPELINE_TABLES[kind])
  }

  return counts as Readonly<Record<PipelineKind, number>>
}

/** A window over `plan_items.date`. `from` and `to` are inclusive; `before` is not. */
export interface DayWindow {
  readonly before?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/**
 * Open steps inside a window. Done items are excluded here rather than in the
 * caller: a step finished last month is not overdue, it is finished.
 */
function openPlanItemConditions(workspaceId: string, window: DayWindow): (SQL | undefined)[] {
  return [
    eq(planItems.workspaceId, workspaceId),
    inArray(planItems.status, [...OPEN_PLAN_ITEM_STATUSES]),
    window.before === undefined ? undefined : lt(planItems.date, window.before),
    window.from === undefined ? undefined : gte(planItems.date, window.from),
    window.to === undefined ? undefined : lte(planItems.date, window.to),
  ]
}

export async function countOpenPlanItems(
  db: Queryable,
  workspaceId: string,
  window: DayWindow,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(planItems)
    .where(and(...openPlanItemConditions(workspaceId, window)))

  return row?.total ?? 0
}

/** Soonest first: the oldest overdue step is the one to triage. */
export function listOpenPlanItems(
  db: Queryable,
  workspaceId: string,
  window: DayWindow,
  limit: number,
): Promise<PlanItemRecord[]> {
  return db
    .select()
    .from(planItems)
    .where(and(...openPlanItemConditions(workspaceId, window)))
    .orderBy(asc(planItems.date), asc(planItems.id))
    .limit(limit)
}

/**
 * Partnerships in an open stage whose touchpoint is on or before `through`.
 *
 * There is no lower bound. A touchpoint that was due last week is the strongest
 * signal on the page, and a window that started today would drop exactly the
 * ones already missed.
 */
function touchpointConditions(workspaceId: string, through: string): (SQL | undefined)[] {
  return [
    eq(partnerships.workspaceId, workspaceId),
    eq(pipelineStages.open, true),
    isNotNull(partnerships.nextTouchpoint),
    lte(partnerships.nextTouchpoint, through),
  ]
}

export async function countPartnershipTouchpoints(
  db: Queryable,
  workspaceId: string,
  through: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(partnerships)
    .innerJoin(pipelineStages, eq(partnerships.stageId, pipelineStages.id))
    .where(and(...touchpointConditions(workspaceId, through)))

  return row?.total ?? 0
}

export async function listPartnershipTouchpoints(
  db: Queryable,
  workspaceId: string,
  through: string,
  limit: number,
): Promise<readonly TouchpointRecord[]> {
  const rows = await db
    .select({
      id: partnerships.id,
      name: partnerships.name,
      companyId: partnerships.companyId,
      nextTouchpoint: partnerships.nextTouchpoint,
      ownerId: partnerships.ownerId,
      summary: partnerships.summary,
    })
    .from(partnerships)
    .innerJoin(pipelineStages, eq(partnerships.stageId, pipelineStages.id))
    .where(and(...touchpointConditions(workspaceId, through)))
    .orderBy(asc(partnerships.nextTouchpoint), asc(partnerships.id))
    .limit(limit)

  // `isNotNull` in the conditions already excluded these, and the column's type
  // does not know that. Dropping an impossible row is narrower than defaulting
  // it to a date nobody chose.
  return rows.flatMap((row) =>
    row.nextTouchpoint === null ? [] : [{ ...row, nextTouchpoint: row.nextTouchpoint }],
  )
}

/**
 * The calendar day a contact happened on, in the workspace's zone.
 *
 * Postgres does the conversion because it owns the stored instant and the zone
 * database. Comparing the text against a `YYYY-MM-DD` bound is exact: the format
 * sorts lexicographically, so no date cast is needed on either side.
 */
function contactedDay(timezone: string): SQL<string> {
  return sql<string>`to_char(${people.lastContactedAt} at time zone ${timezone}, 'YYYY-MM-DD')`
}

/**
 * People last contacted before `cutoffDay`.
 *
 * A person with no `last_contacted_at` at all is not stale. Nothing has been
 * recorded about them either way, and filing "never logged" under "going cold"
 * would fill the list with everyone imported yesterday.
 */
function staleContactConditions(
  workspaceId: string,
  timezone: string,
  cutoffDay: string,
): (SQL | undefined)[] {
  return [
    eq(people.workspaceId, workspaceId),
    isNotNull(people.lastContactedAt),
    sql`${contactedDay(timezone)} < ${cutoffDay}`,
  ]
}

export async function countStaleContacts(
  db: Queryable,
  workspaceId: string,
  timezone: string,
  cutoffDay: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(people)
    .where(and(...staleContactConditions(workspaceId, timezone, cutoffDay)))

  return row?.total ?? 0
}

/** Coldest first: the longest silence leads. */
export async function listStaleContacts(
  db: Queryable,
  workspaceId: string,
  timezone: string,
  cutoffDay: string,
  limit: number,
): Promise<readonly StaleContactRecord[]> {
  const rows = await db
    .select({
      id: people.id,
      name: people.name,
      email: people.email,
      lastContactedAt: people.lastContactedAt,
      lastContactedDay: contactedDay(timezone),
      summary: people.summary,
    })
    .from(people)
    .where(and(...staleContactConditions(workspaceId, timezone, cutoffDay)))
    .orderBy(asc(people.lastContactedAt), asc(people.id))
    .limit(limit)

  // Same impossible row as the touchpoints above, dropped for the same reason.
  return rows.flatMap((row) =>
    row.lastContactedAt === null ? [] : [{ ...row, lastContactedAt: row.lastContactedAt }],
  )
}

export function listRecentActivity(
  db: Queryable,
  workspaceId: string,
  limit: number,
): Promise<ActivityRecord[]> {
  return db
    .select()
    .from(activities)
    .where(eq(activities.workspaceId, workspaceId))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(limit)
}

/**
 * Pinned notes first, then newest.
 *
 * Pinning is how a workspace tells an agent which notes matter (`brief.md`), so
 * the ordering is the point of the list rather than a display preference.
 */
export function listRecentNotes(
  db: Queryable,
  workspaceId: string,
  limit: number,
): Promise<NoteRecord[]> {
  return db
    .select()
    .from(notes)
    .where(eq(notes.workspaceId, workspaceId))
    .orderBy(desc(notes.pinned), desc(notes.createdAt), desc(notes.id))
    .limit(limit)
}

/** Newest commitment first, matching the default sort of `/v1/decisions`. */
export function listRecentDecisions(
  db: Queryable,
  workspaceId: string,
  limit: number,
): Promise<DecisionRecord[]> {
  return db
    .select()
    .from(decisions)
    .where(eq(decisions.workspaceId, workspaceId))
    .orderBy(desc(decisions.decidedAt), desc(decisions.id))
    .limit(limit)
}

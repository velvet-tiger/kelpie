import { PIPELINE_KINDS } from '@kelpie/schemas'
import type { PipelineKind } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { dayIn } from '../../lib/timezones.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { isRecordTargetType, resolveTargetNames, targetKey } from '../recordTargets.ts'
import type { RecordTarget } from '../recordTargets.ts'
import {
  DEFAULT_SIGNAL_LIMIT,
  STALE_CONTACT_DAYS,
  UPCOMING_DAYS,
  daysBetween,
  staleContactCutoff,
  upcomingEnd,
} from './attention.ts'
import * as repository from './repository.ts'

/**
 * The workspace home, assembled in one request.
 *
 * Read-only and composed rather than stored: every number is a live query, so
 * nothing goes stale between a write and the next visit. It is one endpoint
 * rather than seven filtered list calls because two of its signals — a contact
 * going cold, a partnership touchpoint at hand — are questions no resource list
 * answers, and because the page and the `workspace.*` agent tasks both want the
 * whole picture rather than a page of one part of it.
 *
 * Each signal carries an exact `total` beside a capped `items`. The page renders
 * four rows; a brief that said "4 overdue" because four is what it was handed
 * would be wrong every time there are more.
 *
 * `targetType` stays a string here, as it does in every module that owns a
 * polymorphic column. The check constraint is what keeps it to the known set,
 * and the browser's decoder is where it narrows.
 */

/** A signal: how many there are, and the first few of them. */
export interface SignalList<Item> {
  readonly total: number
  readonly items: readonly Item[]
}

export interface PipelineSnapshot {
  readonly kind: PipelineKind
  /** Records sitting in a stage the workspace has marked open. */
  readonly open: number
}

/**
 * A row that names a record it is not itself.
 *
 * `targetName` is null when the target resolved to nothing, which a column with
 * no foreign key permits. A reader shows the type alone rather than an id.
 */
export interface TargetRef {
  readonly targetType: string
  readonly targetId: string
  readonly targetName: string | null
}

export interface PlanItemSignal extends TargetRef {
  readonly id: string
  readonly date: string
  readonly title: string
  readonly ownerId: string | null
  readonly status: string
}

export interface TouchpointSignal {
  readonly id: string
  readonly name: string
  readonly companyId: string
  readonly nextTouchpoint: string
  /** Whether the date has already passed. The list holds both, oldest first. */
  readonly overdue: boolean
  readonly ownerId: string | null
  readonly summary: string
}

export interface StaleContactSignal {
  readonly id: string
  readonly name: string
  readonly email: string | null
  readonly lastContactedAt: Date
  /** Whole days from the last contact to today, both read in the workspace's zone. */
  readonly daysSinceContact: number
  readonly summary: string
}

export interface ActivitySignal extends TargetRef {
  readonly id: string
  readonly kind: string
  readonly actorMemberId: string | null
  readonly actorLabel: string | null
  readonly action: string
  readonly detail: string | null
  readonly createdAt: Date
}

export interface NoteSignal extends TargetRef {
  readonly id: string
  readonly body: string
  readonly authorId: string | null
  readonly pinned: boolean
  readonly createdAt: Date
}

export interface DecisionSignal extends TargetRef {
  readonly id: string
  readonly body: string
  readonly rationale: string | null
  readonly decidedAt: Date
  readonly ownerId: string | null
  readonly dueAt: Date | null
}

export interface DashboardSnapshot {
  readonly generatedAt: Date
  /** The day everything below was computed against, `YYYY-MM-DD`. */
  readonly today: string
  /** The workspace's IANA zone, which is what fixed `today`. */
  readonly timezone: string
  readonly staleContactDays: number
  readonly upcomingDays: number
  readonly pipelines: readonly PipelineSnapshot[]
  readonly overduePlanItems: SignalList<PlanItemSignal>
  readonly dueSoonPlanItems: SignalList<PlanItemSignal>
  readonly partnershipTouchpoints: SignalList<TouchpointSignal>
  readonly staleContacts: SignalList<StaleContactSignal>
  readonly recentActivity: readonly ActivitySignal[]
  readonly recentNotes: readonly NoteSignal[]
  readonly recentDecisions: readonly DecisionSignal[]
}

export interface DashboardDependencies {
  readonly db: Database
  readonly now: () => Date
}

export interface DashboardService {
  /**
   * @param limit How many rows each embedded list carries. The totals beside
   *   them are exact and ignore it.
   */
  snapshot(actor: Actor, limit?: number): Promise<DashboardSnapshot>
}

/** The three day bounds every signal is measured against. */
interface DayBounds {
  readonly today: string
  /** The last day a plan item or touchpoint still counts as due soon. */
  readonly through: string
  /** The first day a contact still counts as fresh. */
  readonly staleCutoff: string
}

/** Everything read from the database, before any of it is named or shaped. */
interface SignalRows {
  readonly openByPipeline: Readonly<Record<PipelineKind, number>>
  readonly overduePlanItems: SignalList<repository.PlanItemRecord>
  readonly dueSoonPlanItems: SignalList<repository.PlanItemRecord>
  readonly partnershipTouchpoints: SignalList<repository.TouchpointRecord>
  readonly staleContacts: SignalList<repository.StaleContactRecord>
  readonly recentActivity: readonly repository.ActivityRecord[]
  readonly recentNotes: readonly repository.NoteRecord[]
  readonly recentDecisions: readonly repository.DecisionRecord[]
}

/**
 * The count and the list of one signal, run one after the other.
 *
 * Sequential inside a group and concurrent across them, so a request holds at
 * most one connection per group. The eight groups below fit under postgres.js's
 * default pool of ten; pairing them up as well would put thirteen queries in
 * flight and let one dashboard request queue everybody else's.
 */
async function readPlanItems(
  db: Database,
  workspaceId: string,
  window: repository.DayWindow,
  limit: number,
): Promise<SignalList<repository.PlanItemRecord>> {
  return {
    total: await repository.countOpenPlanItems(db, workspaceId, window),
    items: await repository.listOpenPlanItems(db, workspaceId, window, limit),
  }
}

async function readTouchpoints(
  db: Database,
  workspaceId: string,
  through: string,
  limit: number,
): Promise<SignalList<repository.TouchpointRecord>> {
  return {
    total: await repository.countPartnershipTouchpoints(db, workspaceId, through),
    items: await repository.listPartnershipTouchpoints(db, workspaceId, through, limit),
  }
}

async function readStaleContacts(
  db: Database,
  workspaceId: string,
  timezone: string,
  cutoff: string,
  limit: number,
): Promise<SignalList<repository.StaleContactRecord>> {
  return {
    total: await repository.countStaleContacts(db, workspaceId, timezone, cutoff),
    items: await repository.listStaleContacts(db, workspaceId, timezone, cutoff, limit),
  }
}

/**
 * Every query the snapshot needs, and nothing that shapes the result.
 *
 * Eight groups in parallel: the page is one screen and thirteen round trips in
 * a row would be felt. None of them is inside a transaction, so nothing here
 * holds a connection while waiting on another.
 *
 * Overdue and due-soon are two windows rather than one list split afterwards, so
 * each total counts the rows in its own bucket instead of the rows in the pair.
 */
async function readSignals(
  db: Database,
  workspaceId: string,
  timezone: string,
  days: DayBounds,
  limit: number,
): Promise<SignalRows> {
  const [
    openByPipeline,
    overduePlanItems,
    dueSoonPlanItems,
    partnershipTouchpoints,
    staleContacts,
    recentActivity,
    recentNotes,
    recentDecisions,
  ] = await Promise.all([
    repository.countOpenByPipeline(db, workspaceId),
    readPlanItems(db, workspaceId, { before: days.today }, limit),
    readPlanItems(db, workspaceId, { from: days.today, to: days.through }, limit),
    readTouchpoints(db, workspaceId, days.through, limit),
    readStaleContacts(db, workspaceId, timezone, days.staleCutoff, limit),
    repository.listRecentActivity(db, workspaceId, limit),
    repository.listRecentNotes(db, workspaceId, limit),
    repository.listRecentDecisions(db, workspaceId, limit),
  ])

  return {
    openByPipeline,
    overduePlanItems,
    dueSoonPlanItems,
    partnershipTouchpoints,
    staleContacts,
    recentActivity,
    recentNotes,
    recentDecisions,
  }
}

/**
 * @returns The target of a polymorphic row, or undefined when its `target_type`
 *   is not one records are attached under. A check constraint rules that out, so
 *   the undefined branch only fires on a value written around the API.
 */
function targetOf(row: { readonly targetType: string; readonly targetId: string }):
  | RecordTarget
  | undefined {
  return isRecordTargetType(row.targetType)
    ? { targetType: row.targetType, targetId: row.targetId }
    : undefined
}

/** Every cross-record row on the page, so one pass resolves all of their names. */
function targetsIn(rows: SignalRows): readonly RecordTarget[] {
  return [
    ...rows.overduePlanItems.items,
    ...rows.dueSoonPlanItems.items,
    ...rows.recentActivity,
    ...rows.recentNotes,
    ...rows.recentDecisions,
  ].flatMap((row) => {
    const target = targetOf(row)

    return target === undefined ? [] : [target]
  })
}

/** Reads a name out of the resolved map, for a row that carries its own target columns. */
type NameOf = (row: { readonly targetType: string; readonly targetId: string }) => string | null

function nameReader(names: ReadonlyMap<string, string>): NameOf {
  return (row) => {
    const target = targetOf(row)

    return target === undefined ? null : (names.get(targetKey(target)) ?? null)
  }
}

function toPlanItemSignal(
  list: SignalList<repository.PlanItemRecord>,
  nameOf: NameOf,
): SignalList<PlanItemSignal> {
  return {
    total: list.total,
    items: list.items.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: nameOf(row),
      date: row.date,
      title: row.title,
      ownerId: row.ownerId,
      status: row.status,
    })),
  }
}

function toTouchpointSignal(
  list: SignalList<repository.TouchpointRecord>,
  today: string,
): SignalList<TouchpointSignal> {
  return {
    total: list.total,
    items: list.items.map((row) => ({
      id: row.id,
      name: row.name,
      companyId: row.companyId,
      nextTouchpoint: row.nextTouchpoint,
      overdue: row.nextTouchpoint < today,
      ownerId: row.ownerId,
      summary: row.summary,
    })),
  }
}

function toStaleContactSignal(
  list: SignalList<repository.StaleContactRecord>,
  today: string,
): SignalList<StaleContactSignal> {
  return {
    total: list.total,
    items: list.items.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      lastContactedAt: row.lastContactedAt,
      daysSinceContact: daysBetween(row.lastContactedDay, today),
      summary: row.summary,
    })),
  }
}

/** Shapes the rows into the answer. Pure: no clock, no database, no ambient state. */
function toSnapshot(
  rows: SignalRows,
  names: ReadonlyMap<string, string>,
  generatedAt: Date,
  timezone: string,
  days: DayBounds,
): DashboardSnapshot {
  const nameOf = nameReader(names)

  return {
    generatedAt,
    today: days.today,
    timezone,
    staleContactDays: STALE_CONTACT_DAYS,
    upcomingDays: UPCOMING_DAYS,
    pipelines: PIPELINE_KINDS.map((kind) => ({ kind, open: rows.openByPipeline[kind] })),
    overduePlanItems: toPlanItemSignal(rows.overduePlanItems, nameOf),
    dueSoonPlanItems: toPlanItemSignal(rows.dueSoonPlanItems, nameOf),
    partnershipTouchpoints: toTouchpointSignal(rows.partnershipTouchpoints, days.today),
    staleContacts: toStaleContactSignal(rows.staleContacts, days.today),
    recentActivity: rows.recentActivity.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: nameOf(row),
      kind: row.kind,
      actorMemberId: row.actorMemberId,
      actorLabel: row.actorLabel,
      action: row.action,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
    recentNotes: rows.recentNotes.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: nameOf(row),
      body: row.body,
      authorId: row.authorId,
      pinned: row.pinned,
      createdAt: row.createdAt,
    })),
    recentDecisions: rows.recentDecisions.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: nameOf(row),
      body: row.body,
      rationale: row.rationale,
      decidedAt: row.decidedAt,
      ownerId: row.ownerId,
      dueAt: row.dueAt,
    })),
  }
}

export function createDashboardService(dependencies: DashboardDependencies): DashboardService {
  async function requireTimezone(workspaceId: string): Promise<string> {
    const timezone = await repository.findWorkspaceTimezone(dependencies.db, workspaceId)

    // The actor is already bound to this workspace, so a miss means it was
    // deleted between resolving the credential and reading it.
    if (timezone === undefined) {
      throw AppError.notFound('Workspace not found')
    }

    return timezone
  }

  return {
    async snapshot(actor, limit = DEFAULT_SIGNAL_LIMIT) {
      const workspaceId = requireWorkspaceId(actor)
      const generatedAt = dependencies.now()
      const timezone = await requireTimezone(workspaceId)
      const today = dayIn(timezone, generatedAt)
      const days: DayBounds = {
        today,
        through: upcomingEnd(today),
        staleCutoff: staleContactCutoff(today),
      }

      const rows = await readSignals(dependencies.db, workspaceId, timezone, days, limit)
      // After the rows, not alongside them: which records need naming is not
      // known until every list has come back.
      const names = await resolveTargetNames(dependencies.db, workspaceId, targetsIn(rows))

      return toSnapshot(rows, names, generatedAt, timezone, days)
    },
  }
}

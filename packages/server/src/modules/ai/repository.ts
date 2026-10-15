import type { Queryable, Transaction } from '../../runtime/transaction.ts'
import { and, count, desc, eq, gte, inArray, isNotNull, lt, lte, notInArray, or, sql } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'

import type { OperationOutcome } from './proposal.ts'
import type { AiRunStatus } from '@kelpie/schemas'
import { workspaces } from '../workspace/schema.ts'
import { PERSON_INTAKE_TASKS } from './rules.ts'
import { aiRuns, aiSettings } from './schema.ts'

const intakeTaskIds: readonly string[] = Object.values(PERSON_INTAKE_TASKS)

/**
 * The shape of the `context` bag persisted with each run. Kept loose (unknown
 * values) so a core payload change does not require a repository update; the
 * context-pack builder is responsible for tolerating missing fields.
 */
export interface AiRunContext {
  readonly target_label?: string
  readonly deep_link?: string
  readonly handbook_slugs?: readonly string[]
  readonly pinned_note_ids?: readonly string[]
  readonly open_plan_ids?: readonly string[]
  readonly open_decision_ids?: readonly string[]
  readonly proposed_decision_ids?: readonly string[]
  readonly related?: Readonly<Record<string, readonly string[]>>
}

/**
 * Drizzle queries for the AI module.
 *
 * Every function takes the workspace id first, the way core's repositories do.
 * No business logic lives here: `service.ts` decides what to do with the rows.
 */

export interface AiSettingsRow {
  readonly workspaceId: string
  /**
   * Left from the HTTP dispatch this module used before core dispatched
   * in-process. No longer read; cleared on the next save.
   */
  readonly dispatchSecretEncrypted: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly apiKeyEncrypted: string | null
  readonly webSearch: boolean
  readonly runLogLimit: number | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface AiRunRecord {
  readonly id: string
  readonly workspaceId: string
  readonly agentRunId: string
  readonly taskId: string
  readonly targetType: string
  readonly targetId: string
  readonly status: AiRunStatus
  readonly model: string
  readonly prompt: string | null
  readonly context: AiRunContext | null
  readonly operations: readonly OperationOutcome[] | null
  readonly failureReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly modelRequests: number | null
  readonly webSearches: number | null
  /** Who may read a person-intake run (`schema.ts`). Null on an agent-task run. */
  readonly requestedBy: string | null
  /** The starting credential's scopes (`schema.ts`). Parsed by the intake code when read. */
  readonly requestedScopes: readonly string[] | null
  /**
   * A person-intake run's reply body while it is kept. Not typed here: the
   * intake code parses it with the wire schema of the run's step when it
   * reads it back.
   */
  readonly result: unknown
  readonly resultExpiresAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

function toRun(row: {
  id: string
  workspaceId: string
  agentRunId: string
  taskId: string
  targetType: string
  targetId: string
  status: string
  model: string
  prompt: string | null
  context: unknown
  operations: unknown
  failureReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  modelRequests: number | null
  webSearches: number | null
  requestedBy: string | null
  requestedScopes: string[] | null
  result: unknown
  resultExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}): AiRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentRunId: row.agentRunId,
    taskId: row.taskId,
    targetType: row.targetType,
    targetId: row.targetId,
    // The check constraint keeps `status` to the four known values; a mismatch
    // means a migration this build does not know about ran.
    status: row.status as AiRunStatus,
    model: row.model,
    prompt: row.prompt,
    context: row.context === null ? null : (row.context as AiRunContext),
    operations:
      row.operations === null ? null : (row.operations as readonly OperationOutcome[]),
    failureReason: row.failureReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    modelRequests: row.modelRequests,
    webSearches: row.webSearches,
    requestedBy: row.requestedBy,
    requestedScopes: row.requestedScopes,
    result: row.result,
    resultExpiresAt: row.resultExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function findSettings(
  db: Queryable,
  workspaceId: string,
): Promise<AiSettingsRow | undefined> {
  const rows = await db
    .select()
    .from(aiSettings)
    .where(eq(aiSettings.workspaceId, workspaceId))
    .limit(1)

  return rows[0]
}

/**
 * Makes the caller's transaction the only one that saves or removes this
 * workspace's settings, until it ends.
 *
 * A save decides from the row it reads: which provider stays, and whether
 * the stored key still fits it. Without the lock, two saves can read the same
 * row and both write, and the row ends with one admin's provider beside
 * another admin's key. Read the row again after this returns; a read from
 * before it may be out of date.
 *
 * The lock is on the workspace row, at `NO KEY UPDATE` strength, the lock a
 * membership change and a webhook registration take. It cannot be on the
 * settings row: a workspace that has not enabled AI has none. A stronger
 * lock would also stop every insert of a row that refers to the workspace.
 */
export async function lockSettings(tx: Transaction, workspaceId: string): Promise<void> {
  await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('no key update')
}

/**
 * The workspace-key fields follow `PATCH` rules: `undefined` keeps the stored
 * value on an update (and writes null on an insert), `null` clears it.
 */
export async function upsertSettings(
  db: Queryable,
  input: {
    readonly workspaceId: string
    readonly provider?: string | null
    readonly model?: string | null
    readonly apiKeyEncrypted?: string | null
    readonly webSearch?: boolean
  },
  now: Date,
): Promise<AiSettingsRow> {
  const keyFields: {
    provider?: string | null
    model?: string | null
    apiKeyEncrypted?: string | null
    webSearch?: boolean
  } = {}
  if (input.provider !== undefined) keyFields.provider = input.provider
  if (input.model !== undefined) keyFields.model = input.model
  if (input.apiKeyEncrypted !== undefined) keyFields.apiKeyEncrypted = input.apiKeyEncrypted
  // Absent on an insert means the column default: on.
  if (input.webSearch !== undefined) keyFields.webSearch = input.webSearch

  const [row] = await db
    .insert(aiSettings)
    .values({
      workspaceId: input.workspaceId,
      dispatchSecretEncrypted: null,
      ...keyFields,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: aiSettings.workspaceId,
      set: {
        dispatchSecretEncrypted: null,
        ...keyFields,
        updatedAt: now,
      },
    })
    .returning()

  // `onConflictDoUpdate().returning()` always returns exactly one row, but the
  // types leave that non-obvious; the throw is a load-bearing invariant guard.
  if (row === undefined) {
    throw new Error('ai_settings upsert returned no row')
  }

  return row
}

export async function deleteSettings(db: Queryable, workspaceId: string): Promise<void> {
  await db.delete(aiSettings).where(eq(aiSettings.workspaceId, workspaceId))
}

export async function deleteRuns(db: Queryable, workspaceId: string): Promise<void> {
  await db.delete(aiRuns).where(eq(aiRuns.workspaceId, workspaceId))
}

/**
 * Inserts a row for the given `agentRunId`, or returns undefined when core
 * redelivered a run we already recorded. `onConflictDoNothing` on the unique
 * index is the whole idempotency guarantee for the intake path.
 */
export async function insertRunIfNew(
  db: Queryable,
  values: {
    readonly id: string
    readonly workspaceId: string
    readonly agentRunId: string
    readonly taskId: string
    readonly targetType: string
    readonly targetId: string
    readonly model: string
    readonly prompt: string
    readonly context: AiRunContext
  },
  now: Date,
): Promise<AiRunRecord | undefined> {
  const rows = await db
    .insert(aiRuns)
    .values({
      id: values.id,
      workspaceId: values.workspaceId,
      agentRunId: values.agentRunId,
      taskId: values.taskId,
      targetType: values.targetType,
      targetId: values.targetId,
      model: values.model,
      prompt: values.prompt,
      context: values.context,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: aiRuns.agentRunId })
    .returning()

  const row = rows[0]

  return row === undefined ? undefined : toRun(row)
}

/**
 * Records a person-intake run, `queued`, for the executor to claim like any
 * other run.
 *
 * The row's own id doubles as its `agent_run_id`, because no core agent run
 * stands behind it and the column is a unique, non-null dedupe key. `context`
 * holds the step's input and the caller, until the run settles.
 */
export async function insertIntakeRun(
  db: Queryable,
  values: {
    readonly id: string
    readonly workspaceId: string
    readonly taskId: string
    readonly model: string
    readonly prompt: string
    readonly context: Readonly<Record<string, unknown>>
    readonly requestedBy: string
    readonly requestedScopes: readonly string[] | null
  },
  now: Date,
): Promise<AiRunRecord> {
  const [row] = await db
    .insert(aiRuns)
    .values({
      id: values.id,
      workspaceId: values.workspaceId,
      agentRunId: values.id,
      taskId: values.taskId,
      targetType: 'workspace',
      targetId: values.workspaceId,
      model: values.model,
      prompt: values.prompt,
      context: values.context,
      requestedBy: values.requestedBy,
      requestedScopes: values.requestedScopes === null ? null : [...values.requestedScopes],
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  if (row === undefined) {
    throw new Error('ai_runs insert returned no row')
  }

  return toRun(row)
}

export async function countRunsSince(
  db: Queryable,
  workspaceId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), gte(aiRuns.createdAt, since)))

  return rows[0]?.value ?? 0
}

export async function countRunningRuns(db: Queryable, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.status, 'running')))

  return rows[0]?.value ?? 0
}

/** True when the workspace has a run waiting for a free slot. */
export async function hasQueuedRun(db: Queryable, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: aiRuns.id })
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.status, 'queued')))
    .limit(1)

  return rows.length > 0
}

/**
 * Marks rows still `running` past `before` as failed with a timeout reason.
 * Deliberately runs on the intake path (there is no scheduler), so a crashed
 * executor never wedges a workspace's queue forever.
 *
 * A person-intake run still `queued` past `before` goes too. Its user is
 * polling for it, and one whose job was lost would otherwise keep the notes
 * and the caller in `prompt` and `context` for good. Agent-task runs that
 * wait are left alone: core's dispatch owns their lifetime.
 *
 * @returns The swept runs, so the caller can log them and report each one settled.
 */
export async function sweepStaleRuns(
  db: Queryable,
  workspaceId: string,
  before: Date,
  now: Date,
  reason: string,
): Promise<AiRunRecord[]> {
  const rows = await db
    .update(aiRuns)
    .set({ status: 'failed', failureReason: reason, prompt: null, context: null, updatedAt: now })
    .where(
      and(
        eq(aiRuns.workspaceId, workspaceId),
        or(
          eq(aiRuns.status, 'running'),
          and(eq(aiRuns.status, 'queued'), inArray(aiRuns.taskId, [...intakeTaskIds])),
        ),
        lt(aiRuns.updatedAt, before),
      ),
    )
    .returning()

  return rows.map(toRun)
}

/**
 * Race-safe claim of the oldest queued run for a workspace.
 *
 * The subquery picks the oldest queued id; the outer `where` reasserts
 * `status = 'queued'` on the row being updated, so two callers that both saw
 * the same id race on the update and only the winner gets a returning row.
 * That is the whole concurrency story — no locks, no scheduler.
 */
export async function claimOldestQueuedRun(
  db: Queryable,
  workspaceId: string,
  now: Date,
): Promise<AiRunRecord | undefined> {
  const rows = await db
    .update(aiRuns)
    .set({ status: 'running', updatedAt: now })
    .where(
      and(
        eq(aiRuns.workspaceId, workspaceId),
        eq(aiRuns.status, 'queued'),
        eq(
          aiRuns.id,
          sql`(select id from ${aiRuns} where workspace_id = ${workspaceId} and status = 'queued' order by created_at asc limit 1)`,
        ),
      ),
    )
    .returning()

  const row = rows[0]

  return row === undefined ? undefined : toRun(row)
}

export interface SettleRunInput {
  readonly status: AiRunStatus
  readonly operations?: readonly OperationOutcome[] | null
  readonly failureReason?: string | null
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
  readonly modelRequests?: number | null
  readonly webSearches?: number | null
  /** A person-intake run's reply body, kept until `resultExpiresAt`. */
  readonly result?: Readonly<Record<string, unknown>>
  readonly resultExpiresAt?: Date
}

export async function settleRun(
  db: Queryable,
  id: string,
  changes: SettleRunInput,
  now: Date,
): Promise<AiRunRecord | undefined> {
  // A settled run keeps metadata only. The prompt and the context bag hold
  // personal data and nothing reads them after the run, so they go now.
  const update: Record<string, unknown> = { status: changes.status, prompt: null, context: null, updatedAt: now }

  if (changes.operations !== undefined) update.operations = changes.operations
  if (changes.failureReason !== undefined) update.failureReason = changes.failureReason
  if (changes.inputTokens !== undefined) update.inputTokens = changes.inputTokens
  if (changes.outputTokens !== undefined) update.outputTokens = changes.outputTokens
  if (changes.modelRequests !== undefined) update.modelRequests = changes.modelRequests
  if (changes.webSearches !== undefined) update.webSearches = changes.webSearches
  if (changes.result !== undefined) update.result = changes.result
  if (changes.resultExpiresAt !== undefined) update.resultExpiresAt = changes.resultExpiresAt

  const rows = await db.update(aiRuns).set(update).where(eq(aiRuns.id, id)).returning()
  const row = rows[0]

  return row === undefined ? undefined : toRun(row)
}

/**
 * Deletes the person-intake results of this workspace whose hour has passed.
 * `result_expires_at` stays, so a read can still say when the result went.
 *
 * @returns How many results went.
 */
export async function clearExpiredResults(db: Queryable, workspaceId: string, now: Date): Promise<number> {
  const cleared = await db
    .update(aiRuns)
    .set({ result: null })
    .where(
      and(eq(aiRuns.workspaceId, workspaceId), isNotNull(aiRuns.result), lte(aiRuns.resultExpiresAt, now)),
    )
    .returning({ id: aiRuns.id })

  return cleared.length
}

/**
 * Bumps `updated_at` while the run is still in flight, so the stale sweep
 * measures inactivity from the most recent heartbeat rather than from the
 * claim. Called on entry to a long provider call.
 */
export async function touchRun(db: Queryable, id: string, now: Date): Promise<void> {
  await db.update(aiRuns).set({ updatedAt: now }).where(eq(aiRuns.id, id))
}

export const RUN_SORTS: SortableFields<AiRunRecord> = {
  created_at: timestampSort(aiRuns.createdAt, (run) => run.createdAt),
}

/** Newest first: a run log is read to find out what just happened. */
export const DEFAULT_RUN_SORT = '-created_at'

export async function listRuns(
  db: Queryable,
  workspaceId: string,
  window: ListWindow<AiRunRecord>,
): Promise<AiRunRecord[]> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), keysetCondition(window, aiRuns.id)))
    .orderBy(...orderByWindow(window, aiRuns.id))
    .limit(window.fetchLimit)

  return rows.map(toRun)
}

/**
 * Deletes the workspace's settled runs that fall outside its newest `keep`
 * runs. Runs created on or after `keepSince` stay whatever `keep` says,
 * because the monthly run limit counts this table: deleting a run from the
 * current month would hand its run back. Queued and running rows stay too.
 * Answers how many rows went.
 */
export async function trimRuns(
  db: Queryable,
  workspaceId: string,
  keep: number,
  keepSince: Date,
): Promise<number> {
  const newest = db
    .select({ id: aiRuns.id })
    .from(aiRuns)
    .where(eq(aiRuns.workspaceId, workspaceId))
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
    .limit(keep)

  const deleted = await db
    .delete(aiRuns)
    .where(
      and(
        eq(aiRuns.workspaceId, workspaceId),
        inArray(aiRuns.status, ['succeeded', 'failed']),
        lt(aiRuns.createdAt, keepSince),
        notInArray(aiRuns.id, newest),
      ),
    )
    .returning({ id: aiRuns.id })

  return deleted.length
}

export async function findRun(
  db: Queryable,
  workspaceId: string,
  id: string,
): Promise<AiRunRecord | undefined> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.id, id)))
    .limit(1)

  const row = rows[0]

  return row === undefined ? undefined : toRun(row)
}

/** Rows the reseal pass walks. */
export async function listSettingsRows(db: Queryable): Promise<readonly AiSettingsRow[]> {
  return db.select().from(aiSettings)
}

/** The two sealed columns of a settings row. */
export type SealedSettingColumn = 'dispatchSecretEncrypted' | 'apiKeyEncrypted'

/**
 * Writes `replacement` over `expected` in one sealed column, and over nothing
 * else.
 *
 * The reseal pass reads a row and writes it later, and an admin can replace
 * the key or save the settings in between. One statement for each column, each
 * with its own condition, so a change to one column neither stops the other's
 * write nor is overwritten by it.
 *
 * @returns False when the column no longer holds `expected`, or the row is
 *   gone. Nothing was written.
 */
export async function replaceSealedSetting(
  db: Queryable,
  workspaceId: string,
  column: SealedSettingColumn,
  expected: string,
  replacement: string,
  now: Date,
): Promise<boolean> {
  const replaced =
    column === 'apiKeyEncrypted'
      ? await db
          .update(aiSettings)
          .set({ apiKeyEncrypted: replacement, updatedAt: now })
          .where(and(eq(aiSettings.workspaceId, workspaceId), eq(aiSettings.apiKeyEncrypted, expected)))
          .returning({ workspaceId: aiSettings.workspaceId })
      : await db
          .update(aiSettings)
          .set({ dispatchSecretEncrypted: replacement, updatedAt: now })
          .where(
            and(eq(aiSettings.workspaceId, workspaceId), eq(aiSettings.dispatchSecretEncrypted, expected)),
          )
          .returning({ workspaceId: aiSettings.workspaceId })

  return replaced.length > 0
}

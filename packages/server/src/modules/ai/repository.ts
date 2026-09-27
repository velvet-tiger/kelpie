import type { Queryable } from '../../runtime/transaction.ts'
import { and, count, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm'

import { keysetCondition, orderByWindow, timestampSort } from '../../lib/pagination.ts'
import type { ListWindow, SortableFields } from '../../lib/pagination.ts'

import type { OperationOutcome } from './proposal.ts'
import type { AiRunStatus } from '@kelpie/schemas'
import { aiRuns, aiSettings } from './schema.ts'

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
 * Records a synchronous run, such as a person-intake call, already `running`.
 *
 * Not queued, so the executor's pump never claims it: the caller makes the
 * model call itself and settles the row. It still counts against the monthly
 * limit and shows in the run log. The row's own id doubles as its
 * `agent_run_id`, because no core agent run stands behind it and the column is
 * a unique, non-null dedupe key.
 */
export async function insertRunningRun(
  db: Queryable,
  values: {
    readonly id: string
    readonly workspaceId: string
    readonly taskId: string
    readonly targetType: string
    readonly targetId: string
    readonly model: string
    readonly prompt: string
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
      targetType: values.targetType,
      targetId: values.targetId,
      model: values.model,
      prompt: values.prompt,
      context: null,
      status: 'running',
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

/**
 * Marks rows still `running` past `before` as failed with a timeout reason.
 * Deliberately runs on the intake path (there is no scheduler), so a crashed
 * executor never wedges a workspace's queue forever.
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
        eq(aiRuns.status, 'running'),
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

  const rows = await db.update(aiRuns).set(update).where(eq(aiRuns.id, id)).returning()
  const row = rows[0]

  return row === undefined ? undefined : toRun(row)
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

export async function updateSealedSettings(
  db: Queryable,
  workspaceId: string,
  changes: {
    readonly dispatchSecretEncrypted?: string
    readonly apiKeyEncrypted?: string
  },
  now: Date,
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: now }

  if (changes.dispatchSecretEncrypted !== undefined) {
    update.dispatchSecretEncrypted = changes.dispatchSecretEncrypted
  }
  if (changes.apiKeyEncrypted !== undefined) {
    update.apiKeyEncrypted = changes.apiKeyEncrypted
  }

  await db.update(aiSettings).set(update).where(eq(aiSettings.workspaceId, workspaceId))
}

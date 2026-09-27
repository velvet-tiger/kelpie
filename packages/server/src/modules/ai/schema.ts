import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { AI_RUN_STATUSES } from '@kelpie/schemas'

/**
 * The AI module's own tables.
 *
 * `ai_settings` marks a workspace as enabled and, when the assembly runs the
 * module in `workspace` key mode, holds the workspace's own provider, model
 * and sealed API key. The AI never speaks to core's MCP
 * endpoint; the executor runs the model with zero tools and applies the
 * operations the model returns through the in-process tool registry itself,
 * using a synthetic actor.
 *
 * The migrations for these tables started in the cloud assembly and moved
 * here with the module. The first four keep their cloud journal timestamps,
 * so a database that applied them there sees them as done.
 *
 * `ai_runs` records every run this module handled: metadata only, never the
 * model's reply. The dedupe key is the
 * `agent_run_id` core assigned, because core dispatches at-least-once in
 * principle (in practice one attempt with no retries, per its own dispatch
 * doctrine) and the intake must be idempotent regardless.
 *
 * **No foreign keys to core's tables.** They live in core's migration
 * directory and drizzle-kit generates from what it can see. Rows are removed on
 * `workspace.deleted` in `service.ts`.
 */

export const aiSettings = pgTable(
  'ai_settings',
  {
    workspaceId: text('workspace_id').primaryKey(),
    /**
     * The sealed `Bearer` header core's engine sent when it dispatched to this
     * module over HTTP. Core now dispatches in-process, so nothing reads it and
     * every save writes null. Kept, nullable, so older rows need no data
     * migration; the reseal pass still covers the values that remain.
     */
    dispatchSecretEncrypted: text('dispatch_secret_encrypted'),
    /**
     * `workspace` key mode only. The provider the admin picked; null falls back
     * to `AI_PROVIDER`. Text rather than an enum, like `status` below, and
     * checked against `AI_PROVIDERS` when read.
     */
    provider: text('provider'),
    /** `workspace` key mode only. Null falls back to `AI_MODEL`, then the provider's default. */
    model: text('model'),
    /**
     * `workspace` key mode only. The provider API key, sealed with
     * `SECRET_ENCRYPTION_KEY`. Null falls back to `AI_API_KEY`. Never returned
     * on the wire; the settings view shows its last four characters.
     */
    apiKeyEncrypted: text('api_key_encrypted'),
    /**
     * Whether person intake may hand the model the provider's web search tool.
     * Either key mode: it is a workspace choice about research, not about the
     * provider. Agent-task runs never search, whatever this says.
     */
    webSearch: boolean('web_search').notNull().default(true),
    /**
     * How many runs this workspace keeps in `ai_runs`. Null falls back to
     * `AI_RUN_LOG_LIMIT`. No UI sets it yet; an operator can write it directly.
     */
    runLogLimit: integer('run_log_limit'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Zero would trim every settled run from before this month.
    check('ai_settings_run_log_limit_check', sql`${table.runLogLimit} is null or ${table.runLogLimit} >= 1`),
  ],
)

export const aiRuns = pgTable(
  'ai_runs',
  {
    // `ai_` + ulid. Owned by the module (`ids.ts`) because core's `ObjectKind`
    // is a closed union of core's own prefixes.
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** Core's `agent_runs.id` — the dedupe key on redelivery. */
    agentRunId: text('agent_run_id').notNull(),
    taskId: text('task_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull().default('queued'),
    /** Model this run used, recorded so a later model change does not rewrite history. */
    model: text('model').notNull(),
    /**
     * The rendered task prompt core sent to intake, or the text a person
     * intake call sent. Held only while the run is in flight, because the
     * executor claims a queued run by id and needs the prompt to start it.
     * Cleared when the run settles or is swept: it holds personal data.
     */
    prompt: text('prompt'),
    /**
     * The `context` bag from core's dispatch payload (`target_label`, deep
     * link, related id buckets, and so on). Persisted alongside the prompt
     * because the executor runs after the intake returns 202 — a claim from
     * `claimOldestQueuedRun` is the only handle it has, and the ids in this
     * bag are what the context-pack builder reads from. Cleared with
     * `prompt` when the run settles, since `target_label` names the record.
     */
    context: jsonb('context'),
    /**
     * The per-operation outcome list this run applied. Null until settle.
     * Shape: `[{ kind, status: 'applied'|'failed'|'skipped', detail }]`.
     * Recorded even on a run that failed after partial application, so the
     * admin log can show exactly what changed.
     */
    operations: jsonb('operations'),
    /** Set only on `failed`: what went wrong, for the run log. */
    failureReason: text('failure_reason'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /**
     * HTTP requests sent to the provider, over the first turn, any paused
     * search resumed, and the repair turn. Null on runs settled before the
     * column existed.
     */
    modelRequests: integer('model_requests'),
    /** Web searches the provider reported for the run. Null as above. */
    webSearches: integer('web_searches'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    // Text plus a check rather than a Postgres enum, matching cloud-plans. Built
    // from the same array the API validates against, so the two cannot drift.
    check(
      'ai_runs_status_check',
      sql`${table.status} in (${sql.raw(AI_RUN_STATUSES.map((status) => `'${status}'`).join(', '))})`,
    ),
    // The dedupe key. A `run_id` core dispatched must land in exactly one row.
    uniqueIndex('ai_runs_agent_run_id_key').on(table.agentRunId),
    // Metering and the run-log listing both scope by workspace.
    index('ai_runs_workspace_idx').on(table.workspaceId),
    // Capacity checks and the stale sweep filter on status within a workspace.
    index('ai_runs_workspace_status_idx').on(table.workspaceId, table.status),
    // Newest-first run-log listing.
    index('ai_runs_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
)

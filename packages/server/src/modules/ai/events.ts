import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the `ai` module.
 *
 * `ai.run.settled` fires once a run ends, `succeeded` or `failed`, from every
 * path that ends one: the executor, person intake, and the stale sweep. It
 * carries counts only, never the prompt, the reply, or record content, so a
 * subscriber can meter model spend without seeing workspace data. A hosted
 * assembly keeps its own usage ledger from it, because the run log is trimmed.
 *
 * The target is the run itself (`ai_run`). Webhooks do not deliver it: their
 * translator drops event names it does not know.
 *
 * Token and request counts are null when the run settled without them: a run
 * that failed before any model call, or one the stale sweep failed.
 *
 * `runId` is this module's own run (`ai_runs.id`). `agentRunId` is the core
 * agent run that dispatched it (`agent_runs.id`, the `runId` of
 * `agent_tasks.run.settled`), or null for a run no agent run stands behind,
 * such as person intake.
 */

export const aiEvents = {
  'ai.run.settled': z.object({
    runId: z.string(),
    agentRunId: z.string().nullable(),
    taskId: z.string(),
    status: z.enum(['succeeded', 'failed']),
    model: z.string(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    modelRequests: z.number().int().nullable(),
    webSearches: z.number().int().nullable(),
    createdAt: z.string(),
    settledAt: z.string(),
  }),
} satisfies ModuleEventCatalog

export interface AiRunSettledData {
  readonly runId: string
  /** The core agent run that dispatched this one, or null when none did (person intake). */
  readonly agentRunId: string | null
  readonly taskId: string
  readonly status: 'succeeded' | 'failed'
  readonly model: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly modelRequests: number | null
  readonly webSearches: number | null
  /** ISO 8601. When the run was admitted. */
  readonly createdAt: string
  /** ISO 8601. When the run settled. */
  readonly settledAt: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'ai.run.settled': AiRunSettledData
  }
}

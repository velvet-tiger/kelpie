import { z } from 'zod'

import { AGENT_TASK_TARGET_TYPES } from './values.ts'
import type { AgentTaskTargetType } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * The optional `ai` module: the "Kelpie AI" agent that runs agent tasks with a
 * model provider and applies the reply through the workspace's own tools.
 *
 * Two key modes, set by the assembly:
 *
 *   - `workspace`: an admin enters a provider, an API key and a model for the
 *     workspace. The deployment may set a fallback key in its environment.
 *     This is what a self-hosted install runs.
 *   - `deployment`: the key is the operator's, from the environment, and the
 *     workspace cannot change provider, key or model. This is what a hosted
 *     deployment runs, usually with a monthly run limit.
 */

export const AI_PROVIDERS = ['openai', 'anthropic'] as const

export type AiProvider = (typeof AI_PROVIDERS)[number]

export const AI_PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

/**
 * The model a provider runs when neither the workspace nor the deployment names one.
 * OpenAI's was `gpt-5-mini` until OpenAI deprecated it (shutdown 2026-12-11).
 */
export const AI_DEFAULT_MODELS: Readonly<Record<AiProvider, string>> = {
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-opus-5',
}

export const AI_KEY_MODES = ['workspace', 'deployment'] as const

export type AiKeyMode = (typeof AI_KEY_MODES)[number]

/** Where the key a run would use comes from. `null` means there is no key. */
export const AI_KEY_SOURCES = ['workspace', 'environment'] as const

export type AiKeySource = (typeof AI_KEY_SOURCES)[number]

export const AI_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const

export type AiRunStatus = (typeof AI_RUN_STATUSES)[number]

export interface AiSettings {
  readonly keyMode: AiKeyMode
  /** True when a run can start now: there is a provider and a key for it. */
  readonly configured: boolean
  readonly enabled: boolean
  readonly provider: AiProvider | null
  readonly model: string
  readonly keySource: AiKeySource | null
  /** The last four characters of the key, for recognition. Never the key. */
  readonly keyHint: string | null
  /** `null` means no limit. */
  readonly monthlyLimit: number | null
  readonly runsThisMonth: number
  /**
   * Whether person intake may use the provider's web search tool. Agent-task
   * runs never search, whatever this says.
   */
  readonly webSearch: boolean
}

export const aiSettingsSchema: z.ZodType<AiSettings, unknown> = z
  .object({
    key_mode: z.enum(AI_KEY_MODES),
    configured: z.boolean(),
    enabled: z.boolean(),
    provider: z.enum(AI_PROVIDERS).nullable(),
    model: z.string(),
    key_source: z.enum(AI_KEY_SOURCES).nullable(),
    key_hint: z.string().nullable(),
    monthly_limit: z.number().int().nullable(),
    runs_this_month: z.number().int(),
    web_search: z.boolean(),
  })
  .transform(
    (wire): AiSettings => ({
      keyMode: wire.key_mode,
      configured: wire.configured,
      enabled: wire.enabled,
      provider: wire.provider,
      model: wire.model,
      keySource: wire.key_source,
      keyHint: wire.key_hint,
      monthlyLimit: wire.monthly_limit,
      runsThisMonth: wire.runs_this_month,
      webSearch: wire.web_search,
    }),
  )

/**
 * `POST /v1/ai/settings`. Enables the module, or saves new values when it is
 * already on. In `deployment` mode every field must be absent.
 *
 * Omitting a field keeps the stored value. `apiKey: null` and `model: null`
 * clear the stored value, so the run falls back to the deployment's
 * environment and the provider's default model.
 *
 * `webSearch` is the one field a `deployment`-mode workspace may send: it
 * switches person intake's web search, not the provider or the key.
 */
export interface AiSettingsInput {
  readonly provider?: AiProvider
  readonly apiKey?: string | null
  readonly model?: string | null
  readonly webSearch?: boolean
}

export function aiSettingsBody(input: AiSettingsInput): Record<string, unknown> {
  return definedFields({
    provider: input.provider,
    api_key: input.apiKey,
    model: input.model,
    web_search: input.webSearch,
  })
}

export interface AiOperationOutcome {
  readonly kind: string
  readonly status: 'applied' | 'failed' | 'skipped'
  readonly detail: string
}

export interface AiRun extends RecordTimestamps {
  readonly id: string
  readonly agentRunId: string
  readonly taskId: string
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly status: AiRunStatus
  readonly model: string
  readonly output: string | null
  readonly operations: readonly AiOperationOutcome[] | null
  readonly failureReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

const operationOutcomeSchema = z.object({
  kind: z.string(),
  status: z.enum(['applied', 'failed', 'skipped']),
  detail: z.string(),
})

export const aiRunSchema: z.ZodType<AiRun, unknown> = z
  .object({
    id: idSchema,
    agent_run_id: idSchema,
    task_id: z.string(),
    target_type: z.enum(AGENT_TASK_TARGET_TYPES),
    target_id: idSchema,
    status: z.enum(AI_RUN_STATUSES),
    model: z.string(),
    output: z.string().nullable(),
    operations: z.array(operationOutcomeSchema).nullable(),
    failure_reason: z.string().nullable(),
    input_tokens: z.number().int().nullable(),
    output_tokens: z.number().int().nullable(),
    ...recordTimestamps,
  })
  .transform(
    (wire): AiRun => ({
      id: wire.id,
      agentRunId: wire.agent_run_id,
      taskId: wire.task_id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      status: wire.status,
      model: wire.model,
      output: wire.output,
      operations: wire.operations,
      failureReason: wire.failure_reason,
      inputTokens: wire.input_tokens,
      outputTokens: wire.output_tokens,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

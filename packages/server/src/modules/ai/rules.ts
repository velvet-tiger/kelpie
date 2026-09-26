import { AI_DEFAULT_MODELS, AI_PROVIDERS } from '@kelpie/schemas'
import type { AiKeySource, AiProvider } from '@kelpie/schemas'

import type { LimitCapability } from '../../runtime/entitlements.ts'

/**
 * What the AI module counts, and the boundaries it counts across.
 *
 * Pure, no database and no clock of its own, so every rule below is testable by
 * passing a date in. The module's I/O lives in `repository.ts`, `provider.ts`,
 * and `executor.ts`.
 */

/**
 * How many AI runs a workspace may start in a calendar month. `seats.limit` is
 * the precedent (a live count, no ledger). Declared by this module. With no
 * provider registered it answers `null`, unlimited, which is what a
 * self-hosted install gets. A hosted deployment answers it from its plan
 * catalog; `0` means AI is not on the workspace's plan.
 */
export const AI_RUNS_LIMIT: LimitCapability = {
  name: 'ai.runs.limit',
  kind: 'limit',
  description: 'How many AI runs a workspace may start per calendar month.',
}

export const DEFAULT_MAX_CONCURRENT_RUNS = 2

export const DEFAULT_RUN_TIMEOUT_MINUTES = 15

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000

/**
 * The maximum number of operations a single proposal may carry.
 *
 * The model returns operations in one JSON reply; the applier walks them
 * sequentially. A hard cap keeps a runaway reply from ballooning both the
 * output token count and the write budget for one dispatch.
 */
export const MAX_OPERATIONS = 20

/**
 * Caps on the individual reads the context pack does before the model call.
 *
 * The pack goes into the model input, so oversized reads spend input tokens
 * for no gain. Each cap is generous enough for the tasks the catalog names
 * but small enough that a workspace with hundreds of pinned notes does not
 * push a single dispatch into a truncation.
 */
export const CONTEXT_PACK_PINNED_NOTE_LIMIT = 10
export const CONTEXT_PACK_PLAN_ITEM_LIMIT = 20
export const CONTEXT_PACK_DECISION_LIMIT = 20
export const CONTEXT_PACK_RELATED_LIMIT = 10

const MILLISECONDS_PER_MINUTE = 60_000

/**
 * The start of the calendar month `now` sits in, in UTC.
 *
 * Fixed to UTC deliberately: usage rolls over at a boundary that does not move
 * with a workspace's timezone. Two workspaces using the same deployment cross
 * the boundary at the same instant, which is what a per-deployment monthly cap
 * needs to mean.
 */
export function monthWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/**
 * Rows still `running` before this moment are the ones the intake sweep marks
 * failed. The value is the earliest point at which the row can still be
 * plausibly alive.
 */
export function staleBefore(now: Date, timeoutMinutes: number): Date {
  return new Date(now.getTime() - timeoutMinutes * MILLISECONDS_PER_MINUTE)
}

/**
 * The dispatch URL core POSTs to, tolerating a base with or without a trailing
 * slash. `new URL` resolves both cases the same way.
 */
export function dispatchEndpointFor(baseUrl: string): string {
  return new URL('/v1/public/ai/dispatch', baseUrl).toString()
}

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value)
}

/** The deployment's AI environment, already validated by the module's config schema. */
export interface AiEnvironment {
  readonly provider: AiProvider | undefined
  readonly apiKey: string | undefined
  readonly model: string | undefined
}

/** What the workspace stored, with the key already opened. `workspace` key mode only. */
export interface AiWorkspaceChoice {
  readonly provider: AiProvider | null
  readonly model: string | null
  readonly apiKey: string | null
}

/** The provider, key and model a run would use, and where the key came from. */
export interface ResolvedAiCredentials {
  readonly provider: AiProvider | null
  readonly model: string
  readonly apiKey: string | null
  readonly keySource: AiKeySource | null
}

/**
 * Decides which provider, key and model a workspace runs with.
 *
 * The workspace's choice wins, field by field. The environment fills a gap
 * only when it names the same provider, because a key or a model for one
 * provider means nothing to another. With no model anywhere, the provider's
 * default applies. Pure, so every branch is testable without a database.
 *
 * In `deployment` key mode the caller passes `workspace: undefined`, and the
 * environment is the whole answer.
 */
export function resolveAiCredentials(
  environment: AiEnvironment,
  workspace: AiWorkspaceChoice | undefined,
): ResolvedAiCredentials {
  const provider = workspace?.provider ?? environment.provider ?? null

  if (provider === null) {
    return { provider: null, model: '', apiKey: null, keySource: null }
  }

  const environmentMatches = environment.provider === provider
  const workspaceKey = workspace?.apiKey ?? null
  const environmentKey = environmentMatches ? (environment.apiKey ?? null) : null
  const apiKey = workspaceKey ?? environmentKey
  const keySource: AiKeySource | null =
    workspaceKey !== null ? 'workspace' : environmentKey !== null ? 'environment' : null
  const model =
    workspace?.model ?? (environmentMatches ? environment.model : undefined) ?? AI_DEFAULT_MODELS[provider]

  return { provider, model, apiKey, keySource }
}

/** The last four characters of a key, for the settings view. Short keys show nothing. */
export function keyHint(apiKey: string | null): string | null {
  if (apiKey === null || apiKey.length < 12) {
    return null
  }

  return apiKey.slice(-4)
}

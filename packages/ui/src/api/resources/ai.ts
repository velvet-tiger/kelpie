import { AI_SERVICE_LABELS, aiRunSchema, aiSettingsBody, aiSettingsSchema } from '@kelpie/schemas'
import type { AiRun, AiSettings, AiSettingsInput } from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createReadOnlyResourceHooks } from '../resource.ts'
import type { ListOptions, MutationResult, RecordListResult, RecordResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/ai/settings` and `/v1/ai/runs`, from the optional `ai` module.
 *
 * Only an assembly that lists the module serves these paths, so the hooks live
 * here for the module's own page and nothing in core calls them.
 *
 * Saving or disabling adds or removes the "Kelpie AI" agent row, so both
 * invalidate the agent list the Run dialog reads.
 */

const SETTINGS_KEY = ['ai_settings'] as const

export function useAiSettings(options: ListOptions = {}): RecordResult<AiSettings> {
  const client = useApiClient()
  const enabled = options.enabled ?? true
  const result = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => client.get('/ai/settings', aiSettingsSchema.parse),
    enabled,
  })

  return {
    record: result.data,
    // A disabled query stays pending forever, which is not the same as loading.
    isLoading: result.isPending && enabled,
    error: toError(result.error),
    isNotFound: result.error instanceof ApiError && result.error.status === 404,
  }
}

/**
 * What to call the install's AI service: "Kelpie AI" on Kelpie Cloud, "Custom
 * provider" on an open source install. Plain "AI" until the settings load.
 */
export function useAiServiceLabel(): string {
  const { record } = useAiSettings()

  return record === undefined ? 'AI' : AI_SERVICE_LABELS[record.service]
}

/** Enables AI, or saves a new provider, key or model when it is on already. */
export function useSaveAiSettings(): MutationResult<AiSettingsInput, AiSettings> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: AiSettingsInput) => client.post('/ai/settings', aiSettingsBody(input), aiSettingsSchema.parse),
    onSuccess: (settings) => {
      cache.setQueryData(SETTINGS_KEY, settings)
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  return asMutationResult(mutation)
}

export function useDisableAi(): MutationResult<void, void> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => client.delete('/ai/settings'),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: SETTINGS_KEY })
      void cache.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  return asMutationResult(mutation)
}

const runs = createReadOnlyResourceHooks<AiRun>({
  name: 'ai_runs',
  path: '/ai/runs',
  decode: aiRunSchema.parse,
})

export function useAiRuns(options: ListOptions = {}): RecordListResult<AiRun> {
  return runs.useList({}, options)
}

const RUN_POLL_INTERVAL_MS = 1500

/**
 * The AI run that core's agent run `agentRunId` started, polled until it
 * settles. `undefined` until the dispatch intake has written it.
 *
 * There is no filter by agent run on `/v1/ai/runs`, so this reads the newest
 * page and picks the row out. A run the menu just dispatched is at the top.
 */
export function useAiRunForAgentRun(agentRunId: string | undefined): AiRun | undefined {
  const client = useApiClient()
  const result = useQuery({
    queryKey: ['ai_runs', 'by_agent_run', agentRunId ?? ''],
    queryFn: async () => {
      const page = await client.list('/ai/runs', aiRunSchema.parse, {})

      return page.items.find((run) => run.agentRunId === agentRunId) ?? null
    },
    enabled: agentRunId !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status

      return status === 'succeeded' || status === 'failed' ? false : RUN_POLL_INTERVAL_MS
    },
  })

  return result.data ?? undefined
}

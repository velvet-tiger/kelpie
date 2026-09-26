import { aiRunSchema, aiSettingsBody, aiSettingsSchema } from '@kelpie/schemas'
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

export function useAiSettings(): RecordResult<AiSettings> {
  const client = useApiClient()
  const result = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => client.get('/ai/settings', aiSettingsSchema.parse),
  })

  return {
    record: result.data,
    isLoading: result.isPending,
    error: toError(result.error),
    isNotFound: result.error instanceof ApiError && result.error.status === 404,
  }
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

import {
  personIntakeApplyResultSchema,
  personIntakeCandidateBody,
  personIntakeItemBody,
  personIntakeRunSchema,
  personIntakeRunStartedSchema,
} from '@kelpie/schemas'
import type {
  PersonIntakeApplyResult,
  PersonIntakeCandidate,
  PersonIntakeItem,
  PersonIntakeRun,
  PersonIntakeRunStarted,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/ai/person-intake/*`, from the optional `ai` module. Only the module's
 * wizard calls these, and only an assembly that lists the module serves them.
 *
 * `identify` and `research` start an AI run on the server's job queue and
 * answer its id at once. The wizard then reads the run every 2 seconds until
 * it settles (`usePersonIntakeRun`). Each run shows in the run log, so
 * starting one refreshes it. `apply` can touch every record type the wizard
 * offers, so it refreshes all of them.
 */

const RUN_LOG_KEY = ['ai_runs'] as const

const WRITTEN_RESOURCES = ['people', 'companies', 'positions', 'notes', 'partnerships', 'deals', 'enquiries'] as const

/** How often the wizard reads a run that has not settled. */
export const PERSON_INTAKE_POLL_INTERVAL_MS = 2000

export function useStartIdentify(): MutationResult<string, PersonIntakeRunStarted> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: (text: string) => client.post('/ai/person-intake/identify', { text }, personIntakeRunStartedSchema.parse),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: RUN_LOG_KEY })
    },
  })

  return asMutationResult(mutation)
}

export interface ResearchPersonInput {
  readonly text: string
  readonly candidate: PersonIntakeCandidate
  /** The Person to add to, or null to create a new one. */
  readonly existingPersonId: string | null
}

export function useStartResearch(): MutationResult<ResearchPersonInput, PersonIntakeRunStarted> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ResearchPersonInput) =>
      client.post(
        '/ai/person-intake/research',
        {
          text: input.text,
          candidate: personIntakeCandidateBody(input.candidate),
          existing_person_id: input.existingPersonId,
        },
        personIntakeRunStartedSchema.parse,
      ),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: RUN_LOG_KEY })
    },
  })

  return asMutationResult(mutation)
}

export interface PersonIntakeRunResult {
  readonly run: PersonIntakeRun | undefined
  readonly error: Error | null
  /** The server has no such run for this caller, or never had one. */
  readonly isNotFound: boolean
}

/** One intake run, read every 2 seconds until it settles. Nothing is read while `runId` is undefined. */
export function usePersonIntakeRun(runId: string | undefined): PersonIntakeRunResult {
  const client = useApiClient()
  const result = useQuery({
    queryKey: ['person_intake_runs', runId ?? ''],
    queryFn: () => client.get(`/ai/person-intake/runs/${encodeURIComponent(runId ?? '')}`, personIntakeRunSchema.parse),
    enabled: runId !== undefined,
    // A settled run never changes again, except that its result goes after an hour.
    staleTime: Infinity,
    refetchInterval: (query) => {
      const status = query.state.data?.status

      return status === 'queued' || status === 'running' ? PERSON_INTAKE_POLL_INTERVAL_MS : false
    },
  })

  return {
    run: result.data,
    error: toError(result.error),
    isNotFound: result.error instanceof ApiError && result.error.status === 404,
  }
}

export function useApplyPersonIntake(): MutationResult<readonly PersonIntakeItem[], PersonIntakeApplyResult> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: (items: readonly PersonIntakeItem[]) =>
      client.post(
        '/ai/person-intake/apply',
        { items: items.map(personIntakeItemBody) },
        personIntakeApplyResultSchema.parse,
      ),
    onSettled: () => {
      for (const name of WRITTEN_RESOURCES) {
        void cache.invalidateQueries({ queryKey: [name] })
      }
    },
  })

  return asMutationResult(mutation)
}

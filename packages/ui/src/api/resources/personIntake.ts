import {
  personIntakeApplyResultSchema,
  personIntakeCandidateBody,
  personIntakeIdentifyResultSchema,
  personIntakeItemBody,
  personIntakeResearchResultSchema,
} from '@kelpie/schemas'
import type {
  PersonIntakeApplyResult,
  PersonIntakeCandidate,
  PersonIntakeIdentifyResult,
  PersonIntakeItem,
  PersonIntakeResearchResult,
} from '@kelpie/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../context.ts'
import type { MutationResult } from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/ai/person-intake/*`, from the optional `ai` module. Only the module's
 * wizard calls these, and only an assembly that lists the module serves them.
 *
 * `identify` and `research` each record an AI run, so both refresh the run
 * log. `apply` can touch every record type the wizard offers, so it refreshes
 * all of them.
 */

const RUN_LOG_KEY = ['ai_runs'] as const

const WRITTEN_RESOURCES = ['people', 'companies', 'positions', 'notes', 'partnerships', 'deals', 'enquiries'] as const

export function useIdentifyPerson(): MutationResult<string, PersonIntakeIdentifyResult> {
  const client = useApiClient()
  const cache = useQueryClient()
  const mutation = useMutation({
    mutationFn: (text: string) =>
      client.post('/ai/person-intake/identify', { text }, personIntakeIdentifyResultSchema.parse),
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

export function useResearchPerson(): MutationResult<ResearchPersonInput, PersonIntakeResearchResult> {
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
        personIntakeResearchResultSchema.parse,
      ),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: RUN_LOG_KEY })
    },
  })

  return asMutationResult(mutation)
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

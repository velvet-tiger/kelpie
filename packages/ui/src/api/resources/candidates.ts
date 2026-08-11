import { candidateBody, candidateSchema, createCandidateBody } from '@kelpie/schemas'
import type { Candidate, CandidateInput, CandidateStatus, CreateCandidateInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/candidates`, the Person↔Role link.
 *
 * There is no single-candidate hook. Every page that shows a candidacy already
 * has the list it came from — a role's pipeline or a person's roles — so a
 * detail fetch would be a second request for a record already on screen.
 */

const candidates = createResourceHooks<Candidate, CreateCandidateInput, CandidateInput>({
  name: 'candidates',
  path: '/candidates',
  decode: candidateSchema.parse,
  createBody: createCandidateBody,
  updateBody: candidateBody,
  // Every write files an activity on the candidate's person, and a delete takes
  // the interview notes with it.
  alsoInvalidates: ['activities', 'notes'],
})

/** The documented filters on `GET /v1/candidates`. */
export interface CandidateFilters {
  /** Candidacies on any of these roles. Repeats on the wire. */
  readonly roleIds?: readonly string[] | undefined
  /** Candidacies held by any of these people. Repeats on the wire. */
  readonly personIds?: readonly string[] | undefined
  /** Candidacies in any of these pipeline states. Repeats on the wire. */
  readonly statuses?: readonly CandidateStatus[] | undefined
  readonly limit?: number | undefined
}

function candidateQuery(filters: CandidateFilters): QueryParameters {
  return {
    role_id: filters.roleIds,
    person_id: filters.personIds,
    status: filters.statuses,
    limit: filters.limit,
  }
}

export function useCandidates(
  filters: CandidateFilters = {},
  options: ListOptions = {},
): RecordListResult<Candidate> {
  return candidates.useList(candidateQuery(filters), options)
}

export function useCreateCandidate(): MutationResult<CreateCandidateInput, Candidate> {
  return candidates.useCreate()
}

export function useUpdateCandidate(): MutationResult<UpdateArguments<CandidateInput>, Candidate> {
  return candidates.useUpdate()
}

export function useDeleteCandidate(): MutationResult<string, void> {
  return candidates.useRemove()
}

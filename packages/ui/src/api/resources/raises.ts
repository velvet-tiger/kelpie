import { raiseBody, raiseSchema } from '@kelpie/schemas'
import type { Raise, RaiseInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/raises`. Create needs a name and a firm; the API lands the raise in the
 * pipeline's first open stage and hands it to the caller as owner.
 */

export interface CreateRaiseInput extends RaiseInput {
  readonly name: string
  readonly companyId: string
}

const raises = createResourceHooks<Raise, CreateRaiseInput, RaiseInput>({
  name: 'raises',
  path: '/raises',
  decode: raiseSchema.parse,
  createBody: raiseBody,
  updateBody: raiseBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/raises`. */
export interface RaiseFilters {
  /** Matches the raise's name, summary, tags, and its firm's name. */
  readonly term?: string
  /** Raises with any of these firms. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  /** Raises sitting in any of these stages. Repeats on the wire. */
  readonly stageIds?: readonly string[]
  /** Raises any of these people are key on. Repeats on the wire. */
  readonly personIds?: readonly string[]
  readonly limit?: number
}

function raiseQuery(filters: RaiseFilters): QueryParameters {
  return {
    q: filters.term,
    company_id: filters.companyIds,
    stage_id: filters.stageIds,
    person_id: filters.personIds,
    limit: filters.limit,
  }
}

export function useRaises(
  filters: RaiseFilters = {},
  options: ListOptions = {},
): RecordListResult<Raise> {
  return raises.useList(raiseQuery(filters), options)
}

export function useRaise(id: string | undefined): RecordResult<Raise> {
  return raises.useRecord(id)
}

export function useCreateRaise(): MutationResult<CreateRaiseInput, Raise> {
  return raises.useCreate()
}

export function useUpdateRaise(): MutationResult<UpdateArguments<RaiseInput>, Raise> {
  return raises.useUpdate()
}

export function useDeleteRaise(): MutationResult<string, void> {
  return raises.useRemove()
}

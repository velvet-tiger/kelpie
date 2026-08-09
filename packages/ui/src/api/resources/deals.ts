import { dealBody, dealSchema } from '@kelpie/schemas'
import type { Deal, DealInput } from '@kelpie/schemas'

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
 * `/v1/deals`. Create needs a name and a company; the API lands the deal in the
 * pipeline's first open stage and hands it to the caller as owner.
 */

export interface CreateDealInput extends DealInput {
  readonly name: string
  readonly companyId: string
}

const deals = createResourceHooks<Deal, CreateDealInput, DealInput>({
  name: 'deals',
  path: '/deals',
  decode: dealSchema.parse,
  createBody: dealBody,
  updateBody: dealBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/deals`. */
export interface DealFilters {
  /** Matches the deal's name, summary, tags, competitors, and its company's name. */
  readonly term?: string
  /** Deals at any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  /** Deals sitting in any of these stages. Repeats on the wire. */
  readonly stageIds?: readonly string[]
  /** Deals any of these people are on. Repeats on the wire. */
  readonly personIds?: readonly string[]
  readonly limit?: number
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string
}

function dealQuery(filters: DealFilters): QueryParameters {
  return {
    q: filters.term,
    company_id: filters.companyIds,
    stage_id: filters.stageIds,
    person_id: filters.personIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useDeals(
  filters: DealFilters = {},
  options: ListOptions = {},
): RecordListResult<Deal> {
  return deals.useList(dealQuery(filters), options)
}

export function useDeal(id: string | undefined): RecordResult<Deal> {
  return deals.useRecord(id)
}

export function useCreateDeal(): MutationResult<CreateDealInput, Deal> {
  return deals.useCreate()
}

export function useUpdateDeal(): MutationResult<UpdateArguments<DealInput>, Deal> {
  return deals.useUpdate()
}

export function useDeleteDeal(): MutationResult<string, void> {
  return deals.useRemove()
}

import { opportunityBody, opportunitySchema } from '@kelpie/schemas'
import type { Opportunity, OpportunityInput } from '@kelpie/schemas'

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
 * `/v1/opportunities`. Create needs only a name; the API lands the opportunity
 * in the pipeline's first open stage and hands it to the caller as owner.
 */

export interface CreateOpportunityInput extends OpportunityInput {
  readonly name: string
}

const opportunities = createResourceHooks<Opportunity, CreateOpportunityInput, OpportunityInput>({
  name: 'opportunities',
  path: '/opportunities',
  decode: opportunitySchema.parse,
  createBody: opportunityBody,
  updateBody: opportunityBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/opportunities`. */
export interface OpportunityFilters {
  /** Matches the opportunity's name, kind, summary, tags, and its company's name. */
  readonly term?: string
  /** Exact kinds ("Grant", "Accelerator", …). Repeats on the wire. */
  readonly kinds?: readonly string[]
  /** Opportunities at any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  /** Opportunities sitting in any of these stages. Repeats on the wire. */
  readonly stageIds?: readonly string[]
  readonly limit?: number
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string
}

function opportunityQuery(filters: OpportunityFilters): QueryParameters {
  return {
    q: filters.term,
    kind: filters.kinds,
    company_id: filters.companyIds,
    stage_id: filters.stageIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useOpportunities(
  filters: OpportunityFilters = {},
  options: ListOptions = {},
): RecordListResult<Opportunity> {
  return opportunities.useList(opportunityQuery(filters), options)
}

export function useOpportunity(id: string | undefined): RecordResult<Opportunity> {
  return opportunities.useRecord(id)
}

export function useCreateOpportunity(): MutationResult<CreateOpportunityInput, Opportunity> {
  return opportunities.useCreate()
}

export function useUpdateOpportunity(): MutationResult<
  UpdateArguments<OpportunityInput>,
  Opportunity
> {
  return opportunities.useUpdate()
}

export function useDeleteOpportunity(): MutationResult<string, void> {
  return opportunities.useRemove()
}

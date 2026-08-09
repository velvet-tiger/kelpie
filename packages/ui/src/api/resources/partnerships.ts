import { partnershipBody, partnershipSchema } from '@kelpie/schemas'
import type { Partnership, PartnershipInput } from '@kelpie/schemas'

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
 * `/v1/partnerships`. Create needs a name and a company; the API lands the
 * partnership in the pipeline's first open stage and hands it to the caller as
 * owner.
 */

export interface CreatePartnershipInput extends PartnershipInput {
  readonly name: string
  readonly companyId: string
}

const partnerships = createResourceHooks<Partnership, CreatePartnershipInput, PartnershipInput>({
  name: 'partnerships',
  path: '/partnerships',
  decode: partnershipSchema.parse,
  createBody: partnershipBody,
  updateBody: partnershipBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/partnerships`. */
export interface PartnershipFilters {
  /** Matches the partnership's name, kind, summary, tags, and its company's name. */
  readonly term?: string
  /** Exact kinds ("Integration", "Co-marketing", …). Repeats on the wire. */
  readonly kinds?: readonly string[]
  /** Partnerships with any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  /** Partnerships sitting in any of these stages. Repeats on the wire. */
  readonly stageIds?: readonly string[]
  /** Partnerships any of these people are on. Repeats on the wire. */
  readonly personIds?: readonly string[]
  readonly limit?: number
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string
}

function partnershipQuery(filters: PartnershipFilters): QueryParameters {
  return {
    q: filters.term,
    kind: filters.kinds,
    company_id: filters.companyIds,
    stage_id: filters.stageIds,
    person_id: filters.personIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function usePartnerships(
  filters: PartnershipFilters = {},
  options: ListOptions = {},
): RecordListResult<Partnership> {
  return partnerships.useList(partnershipQuery(filters), options)
}

export function usePartnership(id: string | undefined): RecordResult<Partnership> {
  return partnerships.useRecord(id)
}

export function useCreatePartnership(): MutationResult<CreatePartnershipInput, Partnership> {
  return partnerships.useCreate()
}

export function useUpdatePartnership(): MutationResult<
  UpdateArguments<PartnershipInput>,
  Partnership
> {
  return partnerships.useUpdate()
}

export function useDeletePartnership(): MutationResult<string, void> {
  return partnerships.useRemove()
}

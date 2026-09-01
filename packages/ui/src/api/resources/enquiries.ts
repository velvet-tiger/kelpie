import { enquiryBody, enquirySchema } from '@kelpie/schemas'
import type { Enquiry, EnquiryInput } from '@kelpie/schemas'
import { createResourceHooks } from '../resource.ts'
import type { QueryParameters } from '../client.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/enquiries`. Top-of-funnel: what a website form or an email drops onto
 * the pipeline before it becomes a deal. Create needs only a name; the API
 * lands the enquiry in the pipeline's first open stage and hands it to the
 * caller as owner.
 */

export interface CreateEnquiryInput extends EnquiryInput {
  readonly name: string
}

const enquiries = createResourceHooks<Enquiry, CreateEnquiryInput, EnquiryInput>({
  name: 'enquiries',
  path: '/enquiries',
  decode: enquirySchema.parse,
  createBody: enquiryBody,
  updateBody: enquiryBody,
  // Every write here emits an activity server-side, in the same transaction,
  // so a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/enquiries`. */
export interface EnquiryFilters {
  /** Matches the enquiry's name, source, summary, tags, and its company's name. */
  readonly term?: string | undefined
  /** Exact sources ("Website", "Email", …). Repeats on the wire. */
  readonly sources?: readonly string[] | undefined
  /** Enquiries at any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[] | undefined
  /** Enquiries sitting in any of these stages. Repeats on the wire. */
  readonly stageIds?: readonly string[] | undefined
  /** Enquiries any of these people are on. Repeats on the wire. */
  readonly personIds?: readonly string[] | undefined
  readonly limit?: number | undefined
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string | undefined
}

function enquiryQuery(filters: EnquiryFilters): QueryParameters {
  return {
    q: filters.term,
    source: filters.sources,
    company_id: filters.companyIds,
    stage_id: filters.stageIds,
    person_id: filters.personIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useEnquiries(
  filters: EnquiryFilters = {},
  options: ListOptions = {},
): RecordListResult<Enquiry> {
  return enquiries.useList(enquiryQuery(filters), options)
}

export function useEnquiry(id: string | undefined): RecordResult<Enquiry> {
  return enquiries.useRecord(id)
}

export function useCreateEnquiry(): MutationResult<CreateEnquiryInput, Enquiry> {
  return enquiries.useCreate()
}

export function useUpdateEnquiry(): MutationResult<UpdateArguments<EnquiryInput>, Enquiry> {
  return enquiries.useUpdate()
}

export function useDeleteEnquiry(): MutationResult<string, void> {
  return enquiries.useRemove()
}

export {
  useConvertEnquiry,
  useConvertPipelineRecord,
  detailPathForPipelineKind,
  convertedTargetPath,
} from './conversions.ts'

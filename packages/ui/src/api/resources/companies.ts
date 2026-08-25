import { companyBody, companySchema } from '@kelpie/schemas'
import type { Company, CompanyInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/** `/v1/companies`. Create needs a name; the API defaults every other field. */

export interface CreateCompanyInput extends CompanyInput {
  readonly name: string
}

const companies = createResourceHooks<Company, CreateCompanyInput, CompanyInput>({
  name: 'companies',
  path: '/companies',
  decode: companySchema.parse,
  createBody: companyBody,
  updateBody: companyBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  // Creating or renaming a domain may also auto-link Positions to workspace
  // people whose email is at it, which changes position lists and the
  // `?company_id=` people list that names the far side of each new row.
  alsoInvalidates: ['activities', 'positions', 'people'],
})

/** The documented filters on `GET /v1/companies`. */
export interface CompanyFilters {
  /** Matches name, domain, industry, summary, account type, and tags. */
  readonly term?: string | undefined
  /** Companies where any of these people holds a position. Repeats on the wire. */
  readonly personIds?: readonly string[] | undefined
  readonly limit?: number | undefined
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string | undefined
}

function companyQuery(filters: CompanyFilters): QueryParameters {
  return {
    q: filters.term,
    person_id: filters.personIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useCompanies(
  filters: CompanyFilters = {},
  options: ListOptions = {},
): RecordListResult<Company> {
  return companies.useList(companyQuery(filters), options)
}

export function useCompany(id: string | undefined): RecordResult<Company> {
  return companies.useRecord(id)
}

export function useCreateCompany(): MutationResult<CreateCompanyInput, Company> {
  return companies.useCreate()
}

export function useUpdateCompany(): MutationResult<UpdateArguments<CompanyInput>, Company> {
  return companies.useUpdate()
}

export function useDeleteCompany(): MutationResult<string, void> {
  return companies.useRemove()
}

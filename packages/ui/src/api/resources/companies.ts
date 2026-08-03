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
})

/** The documented filters on `GET /v1/companies`. */
export interface CompanyFilters {
  /** Matches name, domain, industry, summary, account type, and tags. */
  readonly term?: string
  /** Companies where any of these people holds a position. Repeats on the wire. */
  readonly personIds?: readonly string[]
  readonly limit?: number
}

function companyQuery(filters: CompanyFilters): QueryParameters {
  return { q: filters.term, person_id: filters.personIds, limit: filters.limit }
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

import { personBody, personSchema } from '@kelpie/schemas'
import type { Person, PersonInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/** `/v1/people`. Create needs a name; the API defaults every other field. */

export interface CreatePersonInput extends PersonInput {
  readonly name: string
}

const people = createResourceHooks<Person, CreatePersonInput, PersonInput>({
  name: 'people',
  path: '/people',
  decode: personSchema.parse,
  createBody: personBody,
  updateBody: personBody,
  // Every write here emits an activity server-side, in the same transaction, so
  // a timeline rendered on this record is stale the moment the write lands.
  alsoInvalidates: ['activities'],
})

/** The documented filters on `GET /v1/people`. There is no generic filter DSL. */
export interface PeopleFilters {
  /** Matches name, email, summary, tags, and the titles and companies they hold. */
  readonly term?: string
  /** People holding a position at any of these companies. Repeats on the wire. */
  readonly companyIds?: readonly string[]
  readonly limit?: number
  /** `field` ascending, `-field` descending. Only `name`, `created_at`, `updated_at` are sortable. */
  readonly sort?: string
}

function peopleQuery(filters: PeopleFilters): QueryParameters {
  return {
    q: filters.term,
    company_id: filters.companyIds,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function usePeople(
  filters: PeopleFilters = {},
  options: ListOptions = {},
): RecordListResult<Person> {
  return people.useList(peopleQuery(filters), options)
}

export function usePerson(id: string | undefined): RecordResult<Person> {
  return people.useRecord(id)
}

export function useCreatePerson(): MutationResult<CreatePersonInput, Person> {
  return people.useCreate()
}

export function useUpdatePerson(): MutationResult<UpdateArguments<PersonInput>, Person> {
  return people.useUpdate()
}

export function useDeletePerson(): MutationResult<string, void> {
  return people.useRemove()
}

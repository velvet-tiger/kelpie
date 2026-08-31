import {
  consentPurposeBody,
  consentPurposeSchema,
  createConsentPurposeBody,
} from '@kelpie/schemas'
import type {
  ConsentPurpose,
  ConsentPurposeInput,
  CreateConsentPurposeInput,
} from '@kelpie/schemas'

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
 * `/v1/consent_purposes`. Workspace-defined consent purposes.
 *
 * Every capture site — form consent fields, lists, imports, the manual
 * override on a Person — names one of these. Reads are open to any member;
 * writes need the admin role, enforced server-side.
 */

const consentPurposes = createResourceHooks<
  ConsentPurpose,
  CreateConsentPurposeInput,
  ConsentPurposeInput
>({
  name: 'consent_purposes',
  path: '/consent_purposes',
  decode: consentPurposeSchema.parse,
  createBody: createConsentPurposeBody,
  updateBody: consentPurposeBody,
})

export interface ConsentPurposeFilters {
  readonly term?: string | undefined
  readonly limit?: number | undefined
  readonly sort?: string | undefined
}

function consentPurposeQuery(filters: ConsentPurposeFilters): QueryParameters {
  return {
    q: filters.term,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useConsentPurposes(
  filters: ConsentPurposeFilters = {},
  options: ListOptions = {},
): RecordListResult<ConsentPurpose> {
  return consentPurposes.useList(consentPurposeQuery(filters), options)
}

export function useConsentPurpose(id: string | undefined): RecordResult<ConsentPurpose> {
  return consentPurposes.useRecord(id)
}

export function useCreateConsentPurpose(): MutationResult<
  CreateConsentPurposeInput,
  ConsentPurpose
> {
  return consentPurposes.useCreate()
}

export function useUpdateConsentPurpose(): MutationResult<
  UpdateArguments<ConsentPurposeInput>,
  ConsentPurpose
> {
  return consentPurposes.useUpdate()
}

export function useDeleteConsentPurpose(): MutationResult<string, void> {
  return consentPurposes.useRemove()
}

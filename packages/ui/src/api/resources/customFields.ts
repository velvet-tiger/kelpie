import {
  createCustomFieldDefinitionBody,
  customFieldDefinitionBody,
  customFieldDefinitionSchema,
} from '@kelpie/schemas'
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldDefinitionInput,
  CustomFieldObjectType,
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
 * `/v1/custom_fields`. Workspace-defined field definitions.
 *
 * A record's `custom_fields` values live on that record's own resource — this
 * hook family manages only the definitions. `alsoInvalidates` wakes every
 * pipeline record list because a new definition changes what shows up on their
 * detail pages.
 */

const customFields = createResourceHooks<
  CustomFieldDefinition,
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinitionInput
>({
  name: 'custom_fields',
  path: '/custom_fields',
  decode: customFieldDefinitionSchema.parse,
  createBody: createCustomFieldDefinitionBody,
  updateBody: customFieldDefinitionBody,
})

/** The documented filters on `GET /v1/custom_fields`. */
export interface CustomFieldFilters {
  readonly term?: string | undefined
  readonly objectType?: CustomFieldObjectType | undefined
  readonly limit?: number | undefined
  readonly sort?: string | undefined
}

function customFieldQuery(filters: CustomFieldFilters): QueryParameters {
  return {
    q: filters.term,
    object_type: filters.objectType,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useCustomFields(
  filters: CustomFieldFilters = {},
  options: ListOptions = {},
): RecordListResult<CustomFieldDefinition> {
  return customFields.useList(customFieldQuery(filters), options)
}

export function useCustomField(id: string | undefined): RecordResult<CustomFieldDefinition> {
  return customFields.useRecord(id)
}

export function useCreateCustomField(): MutationResult<
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition
> {
  return customFields.useCreate()
}

export function useUpdateCustomField(): MutationResult<
  UpdateArguments<CustomFieldDefinitionInput>,
  CustomFieldDefinition
> {
  return customFields.useUpdate()
}

export function useDeleteCustomField(): MutationResult<string, void> {
  return customFields.useRemove()
}

import type { CustomFieldValue } from '@kelpie/schemas'

import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { centsToMoney } from './mapping.ts'

/** Definition keys in workspace sort order — the extra CSV columns on a record export. */
export function customFieldHeaderKeys(
  definitions: readonly CustomFieldDefinitionRecord[],
): readonly string[] {
  return definitions.map((definition) => definition.key)
}

/** One custom field value as a single CSV cell. */
export function serializeCustomFieldValue(value: CustomFieldValue | undefined): string {
  if (value === undefined) {
    return ''
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (Array.isArray(value)) {
    return value.join('|')
  }

  if (typeof value === 'object' && 'amountCents' in value && 'currency' in value) {
    return `${centsToMoney(value.amountCents)}|${value.currency}`
  }

  return ''
}

export function customFieldCells(
  values: Readonly<Record<string, CustomFieldValue>> | undefined,
  keys: readonly string[],
): readonly string[] {
  return keys.map((key) => serializeCustomFieldValue(values?.[key]))
}

export function customFieldDefinitionCells(row: CustomFieldDefinitionRecord): readonly string[] {
  return [
    row.objectType,
    row.key,
    row.label,
    row.type,
    row.options.join('|'),
    row.description,
    String(row.sortOrder),
  ]
}

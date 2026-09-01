import type { CustomFieldDefinitionRef, CustomFieldType, CustomFieldWireValue } from '@kelpie/schemas'

import { parseCustomFieldAnswer } from '../forms/applyMappedFields.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { moneyToCents } from './mapping.ts'

/**
 * Custom field columns on a record import: extract, parse, and validate keys.
 *
 * Extra CSV columns named by definition key round-trip with export. A blank cell
 * says nothing about the field, the same additive rule every column follows.
 */

/** Kelpie columns declared for an object, not including workspace definition keys. */
export function baseColumnKeySet(objectColumns: readonly { readonly key: string }[]): ReadonlySet<string> {
  return new Set(objectColumns.map((column) => column.key))
}

/** Non-base, non-blank cells keyed by custom field definition key. */
export function extractCustomFieldRaw(
  mapped: Readonly<Record<string, string>>,
  baseKeys: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const custom: Record<string, string> = {}

  for (const [key, value] of Object.entries(mapped)) {
    if (baseKeys.has(key)) {
      continue
    }

    if (value.trim().length === 0) {
      continue
    }

    custom[key] = value
  }

  return custom
}

function parseCurrency(raw: string): CustomFieldWireValue | undefined {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const [amountPart, currencyPart] = trimmed.split('|')
  const currency = (currencyPart ?? 'USD').trim().toUpperCase()

  if (!/^[A-Z]{3}$/u.test(currency)) {
    return undefined
  }

  const cents = moneyToCents(amountPart)

  if (cents === undefined || cents === null) {
    return undefined
  }

  return { amount_cents: cents, currency }
}

/** Parses one inbound custom-field cell into a wire value for the validator. */
export function parseCustomFieldWireValue(
  definition: CustomFieldDefinitionRecord,
  raw: string,
): CustomFieldWireValue | undefined {
  if (definition.type === 'currency') {
    return parseCurrency(raw)
  }

  const ref: CustomFieldDefinitionRef = {
    objectType: definition.objectType,
    key: definition.key,
    label: definition.label,
    type: definition.type as CustomFieldType,
  }
  const parsed = parseCustomFieldAnswer(ref, raw)

  if (typeof parsed === 'string' && parsed.trim().length === 0) {
    return undefined
  }

  return parsed as CustomFieldWireValue
}

/** Builds the wire map to pass to `createCustomFieldValues`. Unknown keys are omitted. */
export function customFieldWireValues(
  raw: Readonly<Record<string, string>>,
  definitions: readonly CustomFieldDefinitionRecord[],
): Readonly<Record<string, CustomFieldWireValue>> {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  const out: Record<string, CustomFieldWireValue> = {}

  for (const [key, value] of Object.entries(raw)) {
    const definition = byKey.get(key)

    if (definition === undefined) {
      continue
    }

    const parsed = parseCustomFieldWireValue(definition, value)

    if (parsed !== undefined) {
      out[key] = parsed
    }
  }

  return out
}

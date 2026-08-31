import {
  FORM_STANDARD_MAP_FIELDS,
  parseFormMapTarget,
  resolveMapTargetEntry,
} from '@kelpie/schemas'
import type { CustomFieldDefinitionRef, FormMapObjectType, FormMapValueType } from '@kelpie/schemas'

import type { MappedAnswers } from './mapping.ts'
import { fillBlank, isConsentTicked, mergeTags } from './mapping.ts'

/** Targets handled explicitly by `readIntent` and the core upsert paths. */
export const INTENT_HANDLED_TARGETS: ReadonlySet<string> = new Set([
  'person.name',
  'person.first_name',
  'person.last_name',
  'person.email',
  'person.phones',
  'company.name',
  'company.domain',
  'position.title',
  'deal.name',
  'opportunity.name',
  'partnership.name',
  'enquiry.name',
  'person.consent',
  'submission',
])

export interface ObjectMappedValues {
  readonly standard: Readonly<Record<string, string>>
  readonly custom: Readonly<Record<string, string>>
}

/** Groups mapped answers by object type, skipping intent-handled and special targets. */
export function valuesForObject(mapped: MappedAnswers, objectType: FormMapObjectType): ObjectMappedValues {
  const standard: Record<string, string> = {}
  const custom: Record<string, string> = {}

  for (const [target, value] of Object.entries(mapped)) {
    if (INTENT_HANDLED_TARGETS.has(target)) {
      continue
    }

    const parsed = parseFormMapTarget(target)

    if (parsed === undefined || parsed.objectType !== objectType) {
      continue
    }

    if (parsed.isCustomField && parsed.customFieldKey !== undefined) {
      custom[parsed.customFieldKey] = value
    } else {
      standard[parsed.fieldPath] = value
    }
  }

  return { standard, custom }
}

function valueTypeForStandardField(
  objectType: FormMapObjectType,
  field: string,
): FormMapValueType | undefined {
  return FORM_STANDARD_MAP_FIELDS[objectType].find((entry) => entry.field === field)?.valueType
}

function parseStringArray(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseBoolean(raw: string): boolean | undefined {
  return isConsentTicked(raw) ? true : raw.trim().toLowerCase() === 'false' ? false : undefined
}

function parseNumber(raw: string): number | undefined {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  const parsed = Number(trimmed)

  return Number.isFinite(parsed) ? parsed : undefined
}

/** Parses a form answer string into a value suitable for a standard field write. */
export function parseStandardAnswer(
  objectType: FormMapObjectType,
  field: string,
  raw: string,
): unknown {
  const valueType = valueTypeForStandardField(objectType, field)

  if (valueType === undefined) {
    return raw
  }

  switch (valueType) {
    case 'tags':
    case 'string_array':
    case 'phones':
      return parseStringArray(raw)
    case 'boolean':
      return parseBoolean(raw)
    case 'number':
      return parseNumber(raw)
    default:
      return raw.trim()
  }
}

function isBlankStored(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }

  if (typeof value === 'string') {
    return value.trim().length === 0
  }

  if (Array.isArray(value)) {
    return value.length === 0
  }

  return false
}

/** Applies fill-blank for one standard field onto a patch object keyed by repository column names. */
export function applyStandardFillBlank<T extends Record<string, unknown>>(
  stored: T,
  objectType: FormMapObjectType,
  mapped: ObjectMappedValues,
  columnForField: (field: string) => string | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}

  for (const [field, raw] of Object.entries(mapped.standard)) {
    const column = columnForField(field)

    if (column === undefined) {
      continue
    }

    const storedValue = stored[column as keyof T]

    const parsed = parseStandardAnswer(objectType, field, raw)
    const entry = resolveMapTargetEntry(`${objectType}.${field}`)

    if (entry?.valueType === 'tags' && Array.isArray(parsed)) {
      const merge = mergeTags(
        Array.isArray(storedValue) ? (storedValue as readonly string[]) : [],
        parsed,
      )

      if (merge.changed) {
        patch[column] = merge.next
      }

      continue
    }

    if (Array.isArray(parsed)) {
      if (!Array.isArray(storedValue) || storedValue.length === 0) {
        patch[column] = parsed
      }

      continue
    }

    if (typeof parsed === 'boolean') {
      if (storedValue === false && parsed === true) {
        patch[column] = parsed
      }

      continue
    }

    if (typeof parsed === 'number') {
      if (storedValue === null || storedValue === undefined) {
        patch[column] = parsed
      }

      continue
    }

    const filled = fillBlank(
      typeof storedValue === 'string' ? storedValue : storedValue === null ? null : String(storedValue),
      typeof parsed === 'string' ? parsed : undefined,
    )

    if (filled !== undefined) {
      patch[column] = filled
    }
  }

  return patch
}

/** Keys in stored custom_fields that are blank and may be filled from a submit. */
export function customFieldsFillBlankPatch(
  stored: Readonly<Record<string, unknown>>,
  inbound: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const patch: Record<string, string> = {}

  for (const [key, raw] of Object.entries(inbound)) {
    if (raw.trim().length === 0) {
      continue
    }

    if (!isBlankStored(stored[key])) {
      continue
    }

    patch[key] = raw.trim()
  }

  return patch
}

/** Parses inbound custom-field strings into wire values for validation. */
export function parseCustomFieldAnswer(
  definition: CustomFieldDefinitionRef,
  raw: string,
): unknown {
  switch (definition.type) {
    case 'checkbox':
      return isConsentTicked(raw)
    case 'number': {
      const parsed = parseNumber(raw)
      return parsed ?? raw
    }
    case 'multi_select':
      return parseStringArray(raw)
    case 'currency':
      return raw.trim()
    default:
      return raw.trim()
  }
}

export function hasObjectMappedValues(values: ObjectMappedValues): boolean {
  return Object.keys(values.standard).length > 0 || Object.keys(values.custom).length > 0
}

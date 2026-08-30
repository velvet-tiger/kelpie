import type { CustomFieldValue, CustomFieldWireValue } from '@kelpie/schemas'

import { AppError } from '../../lib/errors.ts'
import type { ErrorDetail } from '../../lib/errors.ts'
import type { Queryable } from '../../runtime/transaction.ts'
import { definitionsForObject } from './repository.ts'
import type { CustomFieldDefinitionRecord } from './repository.ts'
import type { CustomFieldObjectType } from './schema.ts'

/**
 * The service half of custom-field values: definition-aware validation, merge
 * semantics, and the per-key diff a `record.updated` event carries.
 *
 * The Zod layer on the record's route body only checks structure (that a value
 * looks like text/number/boolean/list/money). Everything below reads the
 * workspace's definitions and enforces the concrete type, the select-option
 * membership, and the caps every type carries. Mismatches throw the same
 * `AppError.validationFailed(msg, [{field: 'custom_fields.<key>', message}])`
 * `readJsonBody` produces, so an unknown key and a wrong-type value read alike
 * to a client.
 */

const MAX_TEXT_LENGTH = 4096
const MAX_LONG_TEXT_LENGTH = 65536
const MAX_URL_LENGTH = 2048
const MAX_MULTI_SELECT_ENTRIES = 100

/** The stored jsonb value for one custom field, as the record carries it. */
export type StoredCustomFieldValue = CustomFieldValue

/** The result of merging a `PATCH` into the stored `custom_fields` object. */
export interface CustomFieldsMerge {
  /** The whole custom_fields object to write, with keys sorted for stable diffs. */
  readonly merged: Readonly<Record<string, StoredCustomFieldValue>>
  /** Per-key change paths, `customFields.<key>`, for the `.updated` event's `changed`. */
  readonly changedPaths: readonly string[]
  /** Definition labels for the keys that changed, keyed by their `customFields.<key>` path. */
  readonly labels: Readonly<Record<string, string>>
  /** Flat before-values for `describeUpdate`, keyed by `customFields.<key>`. */
  readonly flatBefore: Readonly<Record<string, StoredCustomFieldValue | undefined>>
  /** Flat after-values for `describeUpdate`, keyed by `customFields.<key>`. */
  readonly flatAfter: Readonly<Record<string, StoredCustomFieldValue | undefined>>
}

export interface CustomFieldValuesDependencies {
  readonly db: Queryable
}

export interface CustomFieldValuesValidator {
  /**
   * Validates and normalises the `custom_fields` a record is being created with.
   * `null` keys are ignored. Missing keys are simply absent from the result.
   */
  forCreate(
    tx: Queryable,
    workspaceId: string,
    objectType: CustomFieldObjectType,
    sent: Readonly<Record<string, CustomFieldWireValue | null>> | undefined,
  ): Promise<Readonly<Record<string, StoredCustomFieldValue>>>

  /**
   * Merges a `PATCH` into the stored `custom_fields`, validating every sent
   * key against the workspace's definitions. `null` clears a key. An unknown
   * key is `422`.
   */
  forUpdate(
    tx: Queryable,
    workspaceId: string,
    objectType: CustomFieldObjectType,
    stored: Readonly<Record<string, StoredCustomFieldValue>>,
    sent: Readonly<Record<string, CustomFieldWireValue | null>> | undefined,
  ): Promise<CustomFieldsMerge | undefined>
}

export function createCustomFieldValues(
  _dependencies: CustomFieldValuesDependencies,
): CustomFieldValuesValidator {
  return {
    async forCreate(tx, workspaceId, objectType, sent) {
      if (sent === undefined) {
        return {}
      }
      const definitions = await definitionsForObject(tx, workspaceId, objectType)
      const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
      const out: Record<string, StoredCustomFieldValue> = {}

      for (const [key, value] of Object.entries(sent)) {
        if (value === null) {
          // A create with a `null` value has nothing to store; skip.
          continue
        }
        const definition = byKey.get(key)
        if (definition === undefined) {
          throw unknownKey(key)
        }
        out[key] = validateValue(definition, value)
      }

      return normaliseCustomFields(out)
    },

    async forUpdate(tx, workspaceId, objectType, stored, sent) {
      if (sent === undefined) {
        return undefined
      }
      const definitions = await definitionsForObject(tx, workspaceId, objectType)
      const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
      const next: Record<string, StoredCustomFieldValue> = { ...stored }
      const changedPaths: string[] = []
      const labels: Record<string, string> = {}
      const flatBefore: Record<string, StoredCustomFieldValue | undefined> = {}
      const flatAfter: Record<string, StoredCustomFieldValue | undefined> = {}

      for (const [key, value] of Object.entries(sent)) {
        const definition = byKey.get(key)
        if (definition === undefined) {
          throw unknownKey(key)
        }
        const path = `customFields.${key}`
        const before = stored[key]

        if (value === null) {
          if (before === undefined) {
            continue
          }
          delete next[key]
          changedPaths.push(path)
          labels[path] = definition.label
          flatBefore[path] = before
          flatAfter[path] = undefined
          continue
        }

        const validated = validateValue(definition, value)
        if (!sameValue(before, validated)) {
          next[key] = validated
          changedPaths.push(path)
          labels[path] = definition.label
          flatBefore[path] = before
          flatAfter[path] = validated
        } else {
          // Sent again with the identical value: no change, no path, but keep
          // the value in `next` (a shallow copy already did that).
          next[key] = validated
        }
      }

      return {
        merged: normaliseCustomFields(next),
        changedPaths,
        labels,
        flatBefore,
        flatAfter,
      }
    },
  }
}

/**
 * Rebuilds the object with keys in sorted order.
 *
 * `changedKeys` in `lib/changes.ts` compares by `JSON.stringify`, so two
 * objects with the same entries but different insertion order would look
 * different. Every stored write and every diffed comparison passes through
 * this so the two agree.
 */
export function normaliseCustomFields(
  values: Readonly<Record<string, StoredCustomFieldValue>>,
): Readonly<Record<string, StoredCustomFieldValue>> {
  const sorted: Record<string, StoredCustomFieldValue> = {}
  for (const key of Object.keys(values).sort()) {
    sorted[key] = values[key] as StoredCustomFieldValue
  }
  return sorted
}

function unknownKey(key: string): AppError {
  return AppError.validationFailed('That custom field is not defined for this record type', [
    { field: `custom_fields.${key}`, message: 'Unknown field' },
  ])
}

function typeError(key: string, message: string): AppError {
  return AppError.validationFailed('That value does not match the custom field', [
    { field: `custom_fields.${key}`, message },
  ])
}

function validateValue(
  definition: CustomFieldDefinitionRecord,
  value: CustomFieldWireValue,
): StoredCustomFieldValue {
  switch (definition.type) {
    case 'text':
      return validateString(definition.key, value, MAX_TEXT_LENGTH)

    case 'long_text':
      return validateString(definition.key, value, MAX_LONG_TEXT_LENGTH)

    case 'url':
      return validateUrl(definition.key, value)

    case 'date':
      return validateDate(definition.key, value)

    case 'number':
      return validateNumber(definition.key, value)

    case 'checkbox':
      if (typeof value !== 'boolean') {
        throw typeError(definition.key, 'Expected true or false')
      }
      return value

    case 'select':
      return validateSelect(definition, value)

    case 'multi_select':
      return validateMultiSelect(definition, value)

    case 'currency':
      return validateCurrency(definition.key, value)

    default:
      throw new Error(`custom-field type "${definition.type}" has no validator`)
  }
}

function validateString(key: string, value: CustomFieldWireValue, max: number): string {
  if (typeof value !== 'string') {
    throw typeError(key, 'Expected a string')
  }
  if (value.length > max) {
    throw typeError(key, `At most ${String(max)} characters`)
  }
  return value
}

function validateUrl(key: string, value: CustomFieldWireValue): string {
  const raw = validateString(key, value, MAX_URL_LENGTH)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw typeError(key, 'Expected an http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw typeError(key, 'Expected an http or https URL')
  }
  return raw
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

function validateDate(key: string, value: CustomFieldWireValue): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw typeError(key, 'Expected a YYYY-MM-DD date')
  }
  const [year, month, day] = value.split('-').map((part) => Number(part))
  const parsed = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== (month ?? 1) - 1 ||
    parsed.getUTCDate() !== (day ?? 1)
  ) {
    throw typeError(key, 'That date does not exist')
  }
  return value
}

function validateNumber(key: string, value: CustomFieldWireValue): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw typeError(key, 'Expected a finite number')
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw typeError(key, 'Number is out of range')
  }
  return value
}

function validateSelect(
  definition: CustomFieldDefinitionRecord,
  value: CustomFieldWireValue,
): string {
  if (typeof value !== 'string') {
    throw typeError(definition.key, 'Expected a string')
  }
  if (!definition.options.includes(value)) {
    throw typeError(definition.key, `Not one of the field's options`)
  }
  return value
}

function validateMultiSelect(
  definition: CustomFieldDefinitionRecord,
  value: CustomFieldWireValue,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw typeError(definition.key, 'Expected a list of option keys')
  }
  if (value.length > MAX_MULTI_SELECT_ENTRIES) {
    throw typeError(definition.key, `At most ${String(MAX_MULTI_SELECT_ENTRIES)} entries`)
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw typeError(definition.key, 'Each entry must be a string')
    }
    if (!definition.options.includes(entry)) {
      throw typeError(definition.key, `"${entry}" is not one of the field's options`)
    }
    if (seen.has(entry)) {
      throw typeError(definition.key, `"${entry}" appears more than once`)
    }
    seen.add(entry)
  }
  // A stored multi_select is a plain array; sort for stable JSON comparison.
  return [...value].sort()
}

function validateCurrency(
  key: string,
  value: CustomFieldWireValue,
): { readonly amountCents: number; readonly currency: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('amount_cents' in value) ||
    !('currency' in value)
  ) {
    throw typeError(key, 'Expected { amount_cents, currency }')
  }
  const cents = value.amount_cents
  if (typeof cents !== 'number' || !Number.isInteger(cents)) {
    throw typeError(key, 'amount_cents must be a whole number of cents')
  }
  const currency = value.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/u.test(currency)) {
    throw typeError(key, 'currency must be a 3-letter uppercase code')
  }
  return { amountCents: cents, currency }
}

function sameValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after)
}

/** Collects one detail-list from several field-level rejections. Unused today; kept for future bulk validators. */
export function collectDetails(errors: readonly AppError[]): readonly ErrorDetail[] {
  return errors.flatMap((error) => error.details ?? [])
}

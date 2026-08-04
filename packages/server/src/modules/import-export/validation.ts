import {
  ACCOUNT_TYPES,
  COMPANY_STAGES,
  ICP_FITS,
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
  requiredColumns,
} from '@kelpie/schemas'
import type { ImportObject, MatchKeyOption } from '@kelpie/schemas'

import { isoDateSchema } from '../../lib/dates.ts'
import type { StoredRowError } from './schema.ts'
import { moneyToCents } from './mapping.ts'

/**
 * What a row must look like before anything is looked up.
 *
 * Shape only: required cells present, enums recognised, numbers numeric, dates
 * real. Whether the company a deal names exists is resolution, not validation,
 * and lives in `plan.ts` where the workspace is in hand.
 *
 * Every problem with a row is reported at once. A row fixed one message at a
 * time is four upload cycles, and the caller has the whole row in front of them.
 *
 * Pure.
 */

/** Something on both sides of an `@` and no whitespace. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/u

/**
 * A fixed value set, matched case-insensitively.
 *
 * `import-export.md` says an unknown enum is a row error rather than silently
 * coerced, and that still holds: `Prospect` and `prospect` are the same value
 * written two ways, which is what a person exports from a spreadsheet, while
 * `Client` is unknown and fails.
 */
function readEnum(values: readonly string[], raw: string): string | undefined {
  return values.find((value) => value.toLowerCase() === raw.trim().toLowerCase())
}

/** @returns The canonical stored value, or an error naming what was refused. */
function checkEnum(
  errors: StoredRowError[],
  field: string,
  values: readonly string[],
  raw: string | undefined,
): void {
  if (raw === undefined || raw.trim().length === 0) {
    return
  }

  if (readEnum(values, raw) === undefined) {
    errors.push({
      field,
      message: `Unknown ${field} "${raw.trim()}". Use one of: ${values.join(', ')}`,
    })
  }
}

/** The canonical form of an enum cell, or null when the cell is blank. */
export function canonicalEnum(values: readonly string[], raw: string | undefined): string | null {
  if (raw === undefined || raw.trim().length === 0) {
    return null
  }

  return readEnum(values, raw) ?? null
}

function checkRequired(
  errors: StoredRowError[],
  object: ImportObject,
  matchKey: MatchKeyOption,
  mapped: Readonly<Record<string, string>>,
): void {
  for (const column of requiredColumns(object, matchKey)) {
    if ((mapped[column] ?? '').trim().length === 0) {
      errors.push({ field: column, message: 'Missing required field' })
    }
  }
}

function checkCompany(errors: StoredRowError[], mapped: Readonly<Record<string, string>>): void {
  checkEnum(errors, 'stage', COMPANY_STAGES, mapped.stage)
  checkEnum(errors, 'size_band', SIZE_BANDS, mapped.size_band)
  checkEnum(errors, 'account_type', ACCOUNT_TYPES, mapped.account_type)
  checkEnum(errors, 'icp_fit', ICP_FITS, mapped.icp_fit)
}

function checkPerson(errors: StoredRowError[], mapped: Readonly<Record<string, string>>): void {
  const email = (mapped.email ?? '').trim()

  if (email.length > 0 && !EMAIL_SHAPE.test(email)) {
    errors.push({ field: 'email', message: `"${email}" is not an email address` })
  }

  checkEnum(errors, 'preferred_channel', PREFERRED_CHANNELS, mapped.preferred_channel)
  checkEnum(errors, 'influence', INFLUENCE_LEVELS, mapped.influence)
  checkEnum(errors, 'relationship', RELATIONSHIP_LEVELS, mapped.relationship)
}

function checkPosition(errors: StoredRowError[], mapped: Readonly<Record<string, string>>): void {
  const email = (mapped.person_email ?? '').trim()

  if (email.length > 0 && !EMAIL_SHAPE.test(email)) {
    errors.push({ field: 'person_email', message: `"${email}" is not an email address` })
  }
}

function checkDeal(errors: StoredRowError[], mapped: Readonly<Record<string, string>>): void {
  if (moneyToCents(mapped.value) === undefined) {
    errors.push({ field: 'value', message: `"${mapped.value ?? ''}" is not a number` })
  }

  const close = (mapped.expected_close ?? '').trim()

  if (close.length > 0 && !isoDateSchema.safeParse(close).success) {
    errors.push({ field: 'expected_close', message: `"${close}" is not a date. Use YYYY-MM-DD` })
  }

  const owner = (mapped.owner_email ?? '').trim()

  if (owner.length > 0 && !EMAIL_SHAPE.test(owner)) {
    errors.push({ field: 'owner_email', message: `"${owner}" is not an email address` })
  }
}

/** @returns Every shape problem with the row, or an empty array when it is usable. */
export function validateRow(
  object: ImportObject,
  matchKey: MatchKeyOption,
  mapped: Readonly<Record<string, string>>,
): readonly StoredRowError[] {
  const errors: StoredRowError[] = []

  checkRequired(errors, object, matchKey, mapped)

  // Past a missing required cell the rest is noise: an absent email is not also
  // a malformed one, and the caller has one thing to fix either way.
  if (errors.length > 0) {
    return errors
  }

  switch (object) {
    case 'companies':
      checkCompany(errors, mapped)
      break
    case 'people':
      checkPerson(errors, mapped)
      break
    case 'positions':
      checkPosition(errors, mapped)
      break
    case 'deals':
      checkDeal(errors, mapped)
      break
  }

  return errors
}

import {
  ACCOUNT_TYPES,
  COMPANY_STAGES,
  ICP_FITS,
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SIZE_BANDS,
} from '@kelpie/schemas'

import { normaliseDomain, normaliseEmail } from '../../lib/normalisation.ts'
import { moneyToCents, splitList } from './mapping.ts'
import { canonicalEnum } from './validation.ts'

/**
 * A mapped row, as the columns a write would set.
 *
 * **A mapped column whose cell is blank is left out.** `import-export.md` says
 * update overwrites mapped fields, and the tempting reading is that a blank cell
 * blanks the field. It does not: a partial export with an empty Summary column
 * would then erase every summary in the workspace, and no author of a
 * spreadsheet expects an empty cell to delete anything. A blank cell says
 * nothing about the field. Clearing one stays a job for the record's own PATCH.
 *
 * Pure. Every value here comes from the row; nothing is looked up.
 */

/** A field absent from a draft is not written. Present fields are written as given. */
export interface CompanyDraft {
  readonly name?: string
  readonly domain?: string
  readonly industry?: string
  readonly description?: string
  readonly stage?: string
  readonly sizeBand?: string
  readonly hq?: string
  readonly website?: string
  readonly accountType?: string
  readonly icpFit?: string
  readonly summary?: string
  readonly tags?: readonly string[]
}

export interface PersonDraft {
  readonly name?: string
  readonly email?: string
  readonly phones?: readonly string[]
  readonly timezone?: string
  readonly location?: string
  readonly preferredChannel?: string
  readonly influence?: string
  readonly relationship?: string
  readonly summary?: string
  readonly tags?: readonly string[]
}

/** The deal columns a row carries directly. Company, stage, owner and people are resolved. */
export interface DealFieldsDraft {
  readonly name?: string
  readonly valueCents?: number | null
  readonly expectedClose?: string
  readonly competitors?: readonly string[]
  readonly risks?: string
  readonly whyWin?: string
  readonly summary?: string
  readonly tags?: readonly string[]
  readonly externalId?: string
}

/**
 * Defaults for a Company an import invents, for columns the table requires and
 * a CSV need not carry.
 *
 * `other` and `unknown` rather than the `prospect` a form submit uses: somebody
 * filling in a web form is by definition an inbound prospect, and a row in a
 * migration file says nothing at all about the relationship. Guessing `prospect`
 * for ten thousand companies would put a claim in the data that nobody made.
 * `size_band` has no unknown, so it takes the smallest.
 */
export const NEW_COMPANY_DEFAULTS = {
  stage: 'other',
  sizeBand: '1-10',
  accountType: 'other',
  icpFit: 'unknown',
} as const

/** Defaults for a Person an import invents. Matches what a form submit uses. */
export const NEW_PERSON_DEFAULTS = {
  preferredChannel: 'email',
  influence: 'influencer',
  relationship: 'cold',
} as const

/** The currency a deal takes when a CSV carries a value and no currency column exists. */
export const IMPORT_DEAL_CURRENCY = 'USD'

/** @returns The trimmed cell, or undefined when the column is unmapped or blank. */
function text(mapped: Readonly<Record<string, string>>, column: string): string | undefined {
  const value = (mapped[column] ?? '').trim()

  return value.length === 0 ? undefined : value
}

function list(
  mapped: Readonly<Record<string, string>>,
  column: string,
): readonly string[] | undefined {
  if (text(mapped, column) === undefined) {
    return undefined
  }

  return splitList(mapped[column])
}

function enumeration(
  mapped: Readonly<Record<string, string>>,
  column: string,
  values: readonly string[],
): string | undefined {
  return canonicalEnum(values, mapped[column]) ?? undefined
}

/**
 * Drops the keys whose value is undefined, so a draft holds only what it sets.
 *
 * The parameter is not `T`. Under `exactOptionalPropertyTypes` an optional key
 * declared `name?: string` may be absent but may not be present holding
 * `undefined`, and every literal below spells out all of its keys and lets the
 * extractors return `undefined` for the columns the row did not carry. So the
 * input is `T` with every key required and `undefined` allowed, and the return
 * is `T`, where the absences this function creates are the only ones. Requiring
 * the keys is the useful half: a field left out of a literal is a compile error
 * rather than a column that silently never imports.
 */
type Supplied<T> = { [K in keyof T]-?: T[K] | undefined }

function present<T extends object>(draft: Supplied<T>): T {
  return Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)) as T
}

export function companyDraft(mapped: Readonly<Record<string, string>>): CompanyDraft {
  const domain = text(mapped, 'domain')

  return present<CompanyDraft>({
    name: text(mapped, 'name'),
    domain: domain === undefined ? undefined : (normaliseDomain(domain) ?? undefined),
    industry: text(mapped, 'industry'),
    description: text(mapped, 'description'),
    stage: enumeration(mapped, 'stage', COMPANY_STAGES),
    sizeBand: enumeration(mapped, 'size_band', SIZE_BANDS),
    hq: text(mapped, 'hq'),
    website: text(mapped, 'website'),
    accountType: enumeration(mapped, 'account_type', ACCOUNT_TYPES),
    icpFit: enumeration(mapped, 'icp_fit', ICP_FITS),
    summary: text(mapped, 'summary'),
    tags: list(mapped, 'tags'),
  })
}

export function personDraft(mapped: Readonly<Record<string, string>>): PersonDraft {
  const email = text(mapped, 'email')

  return present<PersonDraft>({
    name: text(mapped, 'name'),
    email: email === undefined ? undefined : (normaliseEmail(email) ?? undefined),
    phones: list(mapped, 'phones'),
    timezone: text(mapped, 'timezone'),
    location: text(mapped, 'location'),
    preferredChannel: enumeration(mapped, 'preferred_channel', PREFERRED_CHANNELS),
    influence: enumeration(mapped, 'influence', INFLUENCE_LEVELS),
    relationship: enumeration(mapped, 'relationship', RELATIONSHIP_LEVELS),
    summary: text(mapped, 'summary'),
    tags: list(mapped, 'tags'),
  })
}

/**
 * `value` is required, so `moneyToCents` has already been checked by
 * `validateRow` and cannot be undefined here.
 */
export function dealFieldsDraft(mapped: Readonly<Record<string, string>>): DealFieldsDraft {
  const cents = moneyToCents(mapped.value)

  return present<DealFieldsDraft>({
    name: text(mapped, 'name'),
    valueCents: cents === undefined ? undefined : cents,
    expectedClose: text(mapped, 'expected_close'),
    competitors: list(mapped, 'competitors'),
    risks: text(mapped, 'risks'),
    whyWin: text(mapped, 'why_win'),
    summary: text(mapped, 'summary'),
    tags: list(mapped, 'tags'),
    externalId: text(mapped, 'external_id'),
  })
}

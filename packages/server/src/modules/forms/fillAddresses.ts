import {
  COMPANY_ADDRESS_KINDS,
  PERSON_ADDRESS_KINDS,
  normaliseCountry,
} from '@kelpie/schemas'
import type { CompanyAddress, PersonAddress } from '@kelpie/schemas'

import { fillBlank } from './mapping.ts'

/**
 * Compose one address from `*.address.*` form answers and fill-blank it onto
 * the stored list. Default kind is mailing on a Person and hq on a Company.
 * An existing address of that kind keeps any part it already has.
 */

const ADDRESS_PART_FIELDS = ['line1', 'line2', 'city', 'region', 'postal_code', 'country'] as const

type AddressPartField = (typeof ADDRESS_PART_FIELDS)[number]

function readPart(
  standard: Readonly<Record<string, string>>,
  field: AddressPartField,
): string | undefined {
  const raw = standard[`address.${field}`]

  if (raw === undefined) {
    return undefined
  }

  const trimmed = raw.trim()

  return trimmed.length === 0 ? undefined : trimmed
}

function hasAddressAnswers(standard: Readonly<Record<string, string>>): boolean {
  if (standard['address.kind'] !== undefined && standard['address.kind'].trim().length > 0) {
    return true
  }

  return ADDRESS_PART_FIELDS.some((field) => readPart(standard, field) !== undefined)
}

function resolveCountry(raw: string | undefined): string | null | undefined {
  if (raw === undefined) {
    return undefined
  }

  return normaliseCountry(raw)
}

function fillPart(stored: string | null, inbound: string | undefined): string | null {
  const filled = fillBlank(stored, inbound)

  return filled === undefined ? stored : filled
}

function mergeAddress<Kind extends string>(
  stored: { readonly line1: string | null; readonly line2: string | null; readonly city: string | null; readonly region: string | null; readonly postalCode: string | null; readonly country: string | null } | undefined,
  inbound: {
    readonly line1: string | undefined
    readonly line2: string | undefined
    readonly city: string | undefined
    readonly region: string | undefined
    readonly postalCode: string | undefined
    readonly country: string | null | undefined
  },
  kind: Kind,
  primary: boolean,
): {
  readonly kind: Kind
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
  readonly primary: boolean
} {
  const empty = {
    line1: null,
    line2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
  }
  const base = stored ?? empty

  return {
    kind,
    line1: fillPart(base.line1, inbound.line1),
    line2: fillPart(base.line2, inbound.line2),
    city: fillPart(base.city, inbound.city),
    region: fillPart(base.region, inbound.region),
    postalCode: fillPart(base.postalCode, inbound.postalCode),
    country: inbound.country === undefined ? base.country : fillPart(base.country, inbound.country ?? undefined),
    primary,
  }
}

function hasLocation(address: {
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
}): boolean {
  return (
    address.line1 !== null ||
    address.line2 !== null ||
    address.city !== null ||
    address.region !== null ||
    address.postalCode !== null ||
    address.country !== null
  )
}

function fillTypedAddress<Kind extends string>(
  stored: readonly {
    readonly kind: Kind
    readonly line1: string | null
    readonly line2: string | null
    readonly city: string | null
    readonly region: string | null
    readonly postalCode: string | null
    readonly country: string | null
    readonly primary: boolean
  }[],
  standard: Readonly<Record<string, string>>,
  kinds: readonly Kind[],
  defaultKind: Kind,
): readonly {
  readonly kind: Kind
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
  readonly primary: boolean
}[] | undefined {
  if (!hasAddressAnswers(standard)) {
    return undefined
  }

  const requested = (standard['address.kind'] ?? '').trim()
  const kind = kinds.includes(requested as Kind) ? (requested as Kind) : defaultKind
  const inbound = {
    line1: readPart(standard, 'line1'),
    line2: readPart(standard, 'line2'),
    city: readPart(standard, 'city'),
    region: readPart(standard, 'region'),
    postalCode: readPart(standard, 'postal_code'),
    country: resolveCountry(readPart(standard, 'country')),
  }

  const existing = stored.find((address) => address.kind === kind)
  const merged = mergeAddress(existing, inbound, kind, existing?.primary ?? stored.length === 0)

  if (!hasLocation(merged)) {
    return undefined
  }

  if (existing === undefined) {
    const next = stored.map((address) => (merged.primary ? { ...address, primary: false } : address))
    return [...next, merged]
  }

  return stored.map((address) => (address.kind === kind ? merged : address))
}

export function fillPersonAddresses(
  stored: readonly PersonAddress[],
  standard: Readonly<Record<string, string>>,
): readonly PersonAddress[] | undefined {
  return fillTypedAddress(stored, standard, PERSON_ADDRESS_KINDS, 'mailing')
}

export function fillCompanyAddresses(
  stored: readonly CompanyAddress[],
  standard: Readonly<Record<string, string>>,
): readonly CompanyAddress[] | undefined {
  return fillTypedAddress(stored, standard, COMPANY_ADDRESS_KINDS, 'hq')
}

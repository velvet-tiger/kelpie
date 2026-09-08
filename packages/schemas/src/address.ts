import { z } from 'zod'

import { countryName, isCountryCode, normaliseCountry } from './countries.ts'

/**
 * Labelled postal addresses on Person and Company.
 *
 * Stored as jsonb arrays, like `phones` and `social_profiles`. They are not a
 * CRM object and have no id. One entry per kind on a record. Wire keys are
 * snake_case; TypeScript is camelCase, mapped at this boundary.
 */

export const PERSON_ADDRESS_KINDS = ['mailing', 'home', 'work', 'other'] as const
export const COMPANY_ADDRESS_KINDS = ['hq', 'billing', 'shipping', 'other'] as const
export const ADDRESS_PARTS = [
  'line1',
  'line2',
  'city',
  'region',
  'postal_code',
  'country',
] as const

export type PersonAddressKind = (typeof PERSON_ADDRESS_KINDS)[number]
export type CompanyAddressKind = (typeof COMPANY_ADDRESS_KINDS)[number]
export type AddressPart = (typeof ADDRESS_PARTS)[number]

export const PERSON_ADDRESS_KIND_LABELS: Readonly<Record<PersonAddressKind, string>> = {
  mailing: 'Mailing',
  home: 'Home',
  work: 'Work',
  other: 'Other',
}

export const COMPANY_ADDRESS_KIND_LABELS: Readonly<Record<CompanyAddressKind, string>> = {
  hq: 'Headquarters',
  billing: 'Billing',
  shipping: 'Shipping',
  other: 'Other',
}

export interface PostalAddress<Kind extends string = string> {
  readonly kind: Kind
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
  readonly primary: boolean
}

export type PersonAddress = PostalAddress<PersonAddressKind>
export type CompanyAddress = PostalAddress<CompanyAddressKind>

/** The parts that hold postal text. `kind` and `primary` are labels, not location. */
const LOCATION_KEYS = ['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const

function blankToNull(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()

  return trimmed.length === 0 ? null : trimmed
}

function hasLocation(address: {
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly region: string | null
  readonly postalCode: string | null
  readonly country: string | null
}): boolean {
  return LOCATION_KEYS.some((key) => address[key] !== null)
}

const nullablePart = z
  .string()
  .nullable()
  .transform((value): string | null => blankToNull(value))

/**
 * A country on the wire: ISO 3166-1 alpha-2, or an English name / alias that
 * resolves to one. Empty becomes null. An unknown string is refused in the
 * address superRefine, after this maps a known name onto its code.
 */
const countryPart = z
  .string()
  .nullable()
  .transform((value): string | null => {
    const trimmed = blankToNull(value)

    if (trimmed === null) {
      return null
    }

    return normaliseCountry(trimmed) ?? trimmed
  })

function postalAddressObjectSchema<const K extends readonly [string, ...string[]]>(kinds: K) {
  return z
    .object({
      kind: z.enum(kinds),
      line1: nullablePart,
      line2: nullablePart,
      city: nullablePart,
      region: nullablePart,
      postal_code: nullablePart,
      country: countryPart,
      primary: z.boolean(),
    })
    .transform(
      (wire): PostalAddress<K[number]> => ({
        kind: wire.kind,
        line1: wire.line1,
        line2: wire.line2,
        city: wire.city,
        region: wire.region,
        postalCode: wire.postal_code,
        country: wire.country,
        primary: wire.primary,
      }),
    )
    .superRefine((address, context) => {
      if (address.country !== null && !isCountryCode(address.country)) {
        context.addIssue({
          code: 'custom',
          message: 'Must be an ISO 3166-1 alpha-2 country code',
          path: ['country'],
        })
      }

      if (!hasLocation(address)) {
        context.addIssue({
          code: 'custom',
          message: 'An address needs at least one of line1, line2, city, region, postal_code, or country',
        })
      }
    })
}

function uniqueKindsAndOnePrimary<Kind extends string>(
  addresses: readonly PostalAddress<Kind>[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  let primaries = 0

  for (const [index, address] of addresses.entries()) {
    if (seen.has(address.kind)) {
      context.addIssue({
        code: 'custom',
        message: 'Each kind may appear only once',
        path: [index, 'kind'],
      })
    }

    seen.add(address.kind)

    if (address.primary) {
      primaries += 1
    }
  }

  if (addresses.length > 0 && primaries !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'A non-empty address list must mark exactly one entry primary',
    })
  }
}

export const personAddressSchema: z.ZodType<PersonAddress, unknown> =
  postalAddressObjectSchema(PERSON_ADDRESS_KINDS)

export const companyAddressSchema: z.ZodType<CompanyAddress, unknown> =
  postalAddressObjectSchema(COMPANY_ADDRESS_KINDS)

export const personAddressesSchema: z.ZodType<readonly PersonAddress[], unknown> = z
  .array(personAddressSchema)
  .superRefine((addresses, context) => {
    uniqueKindsAndOnePrimary(addresses, context)
  })

export const companyAddressesSchema: z.ZodType<readonly CompanyAddress[], unknown> = z
  .array(companyAddressSchema)
  .superRefine((addresses, context) => {
    uniqueKindsAndOnePrimary(addresses, context)
  })

/** The write body for one address. Same keys the response uses. */
export function addressBody(address: PostalAddress): Record<string, unknown> {
  return {
    kind: address.kind,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postal_code: address.postalCode,
    country: address.country,
    primary: address.primary,
  }
}

export function primaryAddress<Kind extends string>(
  addresses: readonly PostalAddress<Kind>[],
): PostalAddress<Kind> | undefined {
  return addresses.find((address) => address.primary) ?? addresses[0]
}

/**
 * One-line display for lists, export, and agents. Country is shown as its
 * English name when we know it, otherwise the stored code. Empty parts are
 * skipped. An empty address (should not reach here) returns an empty string.
 */
export function formatAddress(address: PostalAddress): string {
  const country =
    address.country === null ? null : (countryName(address.country) ?? address.country)
  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.region,
    address.postalCode,
    country,
  ].filter((part): part is string => part !== null && part.length > 0)

  return parts.join(', ')
}

export function addressColumnKey(kind: string, part: AddressPart): string {
  return `${kind}_${part}`
}

export function personAddressColumnKeys(): readonly string[] {
  return PERSON_ADDRESS_KINDS.flatMap((kind) => ADDRESS_PARTS.map((part) => addressColumnKey(kind, part)))
}

export function companyAddressColumnKeys(): readonly string[] {
  return COMPANY_ADDRESS_KINDS.flatMap((kind) => ADDRESS_PARTS.map((part) => addressColumnKey(kind, part)))
}

function titleCaseKind(kind: string): string {
  if (kind === 'hq') {
    return 'HQ'
  }

  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function partLabel(part: AddressPart): string {
  switch (part) {
    case 'line1':
      return 'line 1'
    case 'line2':
      return 'line 2'
    case 'postal_code':
      return 'postal code'
    default:
      return part
  }
}

export function addressColumnLabel(kind: string, part: AddressPart): string {
  return `${titleCaseKind(kind)} ${partLabel(part)}`
}

/**
 * Build address-part CSV columns for one object's kinds, in kind then part
 * order. Used by `OBJECT_COLUMNS` so import and export share one header list.
 */
export function addressCsvColumns(kinds: readonly string[]): readonly {
  readonly key: string
  readonly label: string
  readonly required: false
}[] {
  return kinds.flatMap((kind) =>
    ADDRESS_PARTS.map((part) => ({
      key: addressColumnKey(kind, part),
      label: addressColumnLabel(kind, part),
      required: false as const,
    })),
  )
}

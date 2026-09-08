import {
  ADDRESS_PARTS,
  addressColumnKey,
  COMPANY_ADDRESS_KINDS,
  PERSON_ADDRESS_KINDS,
} from '@kelpie/schemas'
import type {
  AddressPart,
  CompanyAddress,
  CompanyAddressKind,
  PersonAddress,
  PersonAddressKind,
  PostalAddress,
} from '@kelpie/schemas'
import { normaliseCountry } from '@kelpie/schemas'

/**
 * Flattened CSV address columns → jsonb addresses, and the reverse for export.
 *
 * One group per kind. A group with any non-empty part becomes an address of
 * that kind. The first non-empty kind in the object's kind order is primary.
 * An unknown country is a warning and leaves `country` null rather than
 * failing the row.
 */

export interface AddressImportWarning {
  readonly field: string
  readonly message: string
}

export interface AddressImportResult<Kind extends string> {
  readonly addresses: readonly PostalAddress<Kind>[] | undefined
  readonly warnings: readonly AddressImportWarning[]
}

const CAMEL_PART: Readonly<Record<AddressPart, 'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'country'>> =
  {
    line1: 'line1',
    line2: 'line2',
    city: 'city',
    region: 'region',
    postal_code: 'postalCode',
    country: 'country',
  }

function cell(mapped: Readonly<Record<string, string>>, key: string): string | undefined {
  const value = (mapped[key] ?? '').trim()

  return value.length === 0 ? undefined : value
}

function addressesFromMapped<Kind extends string>(
  mapped: Readonly<Record<string, string>>,
  kinds: readonly Kind[],
): AddressImportResult<Kind> {
  const warnings: AddressImportWarning[] = []
  const addresses: PostalAddress<Kind>[] = []

  for (const kind of kinds) {
    const parts: {
      line1: string | null
      line2: string | null
      city: string | null
      region: string | null
      postalCode: string | null
      country: string | null
    } = {
      line1: cell(mapped, addressColumnKey(kind, 'line1')) ?? null,
      line2: cell(mapped, addressColumnKey(kind, 'line2')) ?? null,
      city: cell(mapped, addressColumnKey(kind, 'city')) ?? null,
      region: cell(mapped, addressColumnKey(kind, 'region')) ?? null,
      postalCode: cell(mapped, addressColumnKey(kind, 'postal_code')) ?? null,
      country: null,
    }

    const countryRaw = cell(mapped, addressColumnKey(kind, 'country'))

    if (countryRaw !== undefined) {
      const code = normaliseCountry(countryRaw)

      if (code === null) {
        warnings.push({
          field: addressColumnKey(kind, 'country'),
          message: `"${countryRaw}" is not a country Kelpie knows. Country left blank`,
        })
      } else {
        parts.country = code
      }
    }

    const hasPart = Object.values(parts).some((value) => value !== null)

    if (!hasPart) {
      continue
    }

    addresses.push({
      kind,
      ...parts,
      primary: false,
    })
  }

  if (addresses.length === 0) {
    return { addresses: undefined, warnings }
  }

  return {
    addresses: addresses.map((address, index) => ({ ...address, primary: index === 0 })),
    warnings,
  }
}

export function personAddressesFromMapped(
  mapped: Readonly<Record<string, string>>,
): AddressImportResult<PersonAddressKind> {
  return addressesFromMapped(mapped, PERSON_ADDRESS_KINDS)
}

export function companyAddressesFromMapped(
  mapped: Readonly<Record<string, string>>,
): AddressImportResult<CompanyAddressKind> {
  return addressesFromMapped(mapped, COMPANY_ADDRESS_KINDS)
}

function partValue(address: PostalAddress | undefined, part: AddressPart): string {
  if (address === undefined) {
    return ''
  }

  const value = address[CAMEL_PART[part]]

  return value ?? ''
}

export function personAddressCells(addresses: readonly PersonAddress[]): readonly string[] {
  return PERSON_ADDRESS_KINDS.flatMap((kind) => {
    const address = addresses.find((entry) => entry.kind === kind)

    return ADDRESS_PARTS.map((part) => partValue(address, part))
  })
}

export function companyAddressCells(addresses: readonly CompanyAddress[]): readonly string[] {
  return COMPANY_ADDRESS_KINDS.flatMap((kind) => {
    const address = addresses.find((entry) => entry.kind === kind)

    return ADDRESS_PARTS.map((part) => partValue(address, part))
  })
}

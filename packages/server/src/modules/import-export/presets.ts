import { OBJECT_COLUMNS } from '@kelpie/schemas'
import type { ImportColumnMap, ImportObject, ImportSource } from '@kelpie/schemas'

/**
 * Source packs: the header a vendor's CSV export uses for each Kelpie column,
 * and the stage names their pipelines ship with.
 *
 * Server-side rather than in `@kelpie/schemas`, because a caller sends a
 * `column_map` and never needs to know how one was derived. The endpoint derives
 * it when the request omits it, which is what keeps an agent from having to
 * reimplement any of this.
 *
 * Ported from `mockups/src/data/importExport.ts`. Pure.
 */

type SourcePreset = Partial<Record<ImportObject, Readonly<Record<string, string>>>>

export const SOURCE_PRESETS: Readonly<Record<ImportSource, SourcePreset>> = {
  custom: {},
  hubspot: {
    companies: {
      name: 'Name',
      domain: 'Company Domain Name',
      industry: 'Industry',
      hq_line1: 'Address',
      hq_line2: 'Address 2',
      hq_city: 'City',
      hq_region: 'State/Region',
      hq_postal_code: 'Postal Code',
      hq_country: 'Country',
      description: 'Description',
    },
    people: {
      // Both, because a HubSpot contact export carries the parts and often no
      // full name at all. A preset header the file does not have falls through
      // to the exact-key match below, so mapping all three costs a file nothing.
      name: 'Full Name',
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      phones: 'Phone Number',
      mailing_line1: 'Address',
      mailing_line2: 'Address 2',
      mailing_city: 'City',
      mailing_region: 'State/Region',
      mailing_postal_code: 'Postal Code',
      mailing_country: 'Country',
      company_domain: 'Company Domain Name',
      title: 'Job Title',
    },
    positions: {
      person_email: 'Email',
      company_domain: 'Company Domain Name',
      title: 'Job Title',
    },
    deals: {
      name: 'Deal Name',
      company_domain: 'Associated Company Domain',
      stage: 'Deal Stage',
      value: 'Amount',
      owner_email: 'Owner Email',
      expected_close: 'Close Date',
      external_id: 'Record ID',
    },
  },
  salesforce: {
    companies: {
      name: 'Account Name',
      domain: 'Website',
      industry: 'Industry',
      billing_line1: 'Billing Street',
      billing_city: 'Billing City',
      billing_region: 'Billing State/Province',
      billing_postal_code: 'Billing Zip/Postal Code',
      billing_country: 'Billing Country',
      shipping_line1: 'Shipping Street',
      shipping_city: 'Shipping City',
      shipping_region: 'Shipping State/Province',
      shipping_postal_code: 'Shipping Zip/Postal Code',
      shipping_country: 'Shipping Country',
      description: 'Description',
    },
    people: {
      name: 'Full Name',
      salutation: 'Salutation',
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      phones: 'Phone',
      mailing_line1: 'Mailing Street',
      mailing_city: 'Mailing City',
      mailing_region: 'Mailing State/Province',
      mailing_postal_code: 'Mailing Zip/Postal Code',
      mailing_country: 'Mailing Country',
      other_line1: 'Other Street',
      other_city: 'Other City',
      other_region: 'Other State/Province',
      other_postal_code: 'Other Zip/Postal Code',
      other_country: 'Other Country',
      company_name: 'Account Name',
      // Salesforce's Contact.Title is the job title, and a job title is a
      // Position. It is not this object's `suffix`, which stays unmapped.
      title: 'Title',
    },
    positions: {
      person_email: 'Email',
      company_domain: 'Account Website',
      title: 'Title',
    },
    deals: {
      name: 'Opportunity Name',
      company_domain: 'Account Website',
      stage: 'Stage',
      value: 'Amount',
      owner_email: 'Owner Email',
      expected_close: 'Close Date',
      external_id: 'Opportunity ID',
    },
  },
  attio: {
    // Attio's export writes one column per attribute, and a linked or nested
    // attribute as `Parent > Child`. Only Companies and People are mapped: the
    // sample export carries no Deals or Positions file, and an Attio People row
    // names its company but not the company's domain, so a Position could not be
    // keyed from it. Those objects fall back to `custom`.
    companies: {
      name: 'Record',
      domain: 'Domains',
      industry: 'Categories',
      description: 'Description',
      hq_line1: 'Primary location > Line 1',
      hq_line2: 'Primary location > Line 2',
      hq_city: 'Primary location > Locality',
      hq_region: 'Primary location > Region',
      hq_postal_code: 'Primary location > Postcode',
      hq_country: 'Primary location > Country',
    },
    people: {
      name: 'Record',
      email: 'Email addresses',
      mailing_line1: 'Primary location > Line 1',
      mailing_line2: 'Primary location > Line 2',
      mailing_city: 'Primary location > Locality',
      mailing_region: 'Primary location > Region',
      mailing_postal_code: 'Primary location > Postcode',
      mailing_country: 'Primary location > Country',
      company_name: 'Company > Name',
      title: 'Job title',
    },
  },
}

/**
 * Vendor deal-stage names, reduced to the slug of a Kelpie starter stage.
 *
 * This is an alias table, not the answer: the slug it produces is looked up
 * against the workspace's own deal pipeline, which a workspace is free to have
 * renamed or rebuilt. A slug with no stage behind it is a row error.
 *
 * Keys are compared after the normalisation in `stageAliasKeys`, so one entry
 * covers `Closed Won`, `closedwon` and `closed_won`.
 */
export const DEAL_STAGE_ALIASES: Readonly<Record<string, string>> = {
  qualifying: 'qualifying',
  qualification: 'qualifying',
  prospecting: 'qualifying',
  appointment_scheduled: 'qualifying',
  qualified_to_buy: 'qualifying',
  proposal: 'proposal',
  presentation_scheduled: 'proposal',
  proposal_price_quote: 'proposal',
  value_proposition: 'proposal',
  negotiation: 'negotiation',
  negotiation_review: 'negotiation',
  decision_maker_bought_in: 'negotiation',
  perception_analysis: 'negotiation',
  won: 'won',
  closed_won: 'won',
  lost: 'lost',
  closed_lost: 'lost',
}

/**
 * A stage name with every separator removed.
 *
 * Vendors write one stage several ways — `Closed Won`, `closed_won`,
 * `CLOSEDWON` — and squashing all of them to `closedwon` makes them one key. It
 * is the only form that works on `closedwon`, which has no separator left to
 * split on.
 */
function squash(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_\-/]+/gu, '')
}

/**
 * The alias table indexed by squashed name, built once.
 *
 * Two entries squashing to the same key would be one entry with the last
 * definition winning, so the build refuses it rather than silently dropping an
 * alias somebody wrote on purpose.
 */
const ALIASES_BY_SQUASHED_NAME: ReadonlyMap<string, string> = ((): ReadonlyMap<string, string> => {
  const index = new Map<string, string>()

  for (const [name, slug] of Object.entries(DEAL_STAGE_ALIASES)) {
    const key = squash(name)
    const existing = index.get(key)

    if (existing !== undefined && existing !== slug) {
      throw new Error(`Deal stage aliases "${name}" and another both reduce to "${key}"`)
    }

    index.set(key, slug)
  }

  return index
})()

/** @returns The Kelpie stage slug a vendor name aliases to, or undefined. */
export function aliasedStageSlug(raw: string): string | undefined {
  return ALIASES_BY_SQUASHED_NAME.get(squash(raw))
}

/** A file that names a website but not a domain still has a homepage. */
const DOMAIN_HEADER_ALIASES = new Set(['website', 'website url', 'url'])

/**
 * The column map to use when a request sends none.
 *
 * The source's preset wins, then an exact header match ignoring case, then the
 * column is left unmapped. Preset first because a HubSpot file has both a
 * `Name` and a `Company Domain Name`, and the preset knows which is which.
 *
 * @param headers The file's own header row.
 */
export function defaultColumnMap(
  source: ImportSource,
  object: ImportObject,
  headers: readonly string[],
): ImportColumnMap {
  const preset = SOURCE_PRESETS[source][object] ?? {}
  const present = new Set(headers)
  const map: Record<string, string | null> = {}

  for (const column of OBJECT_COLUMNS[object]) {
    const fromPreset = preset[column.key]

    if (fromPreset !== undefined && present.has(fromPreset)) {
      map[column.key] = fromPreset
      continue
    }

    map[column.key] =
      headers.find((header) => header.toLowerCase() === column.key.toLowerCase()) ?? null
  }

  if (object === 'companies' && map.domain === null) {
    const alias = headers.find((header) => DOMAIN_HEADER_ALIASES.has(header.toLowerCase()))

    if (alias !== undefined) {
      map.domain = alias
    }
  }

  return map
}

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
      website: 'Website URL',
      hq: 'City',
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
      location: 'City',
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
      hq: 'Billing City',
      description: 'Description',
    },
    people: {
      name: 'Full Name',
      salutation: 'Salutation',
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      phones: 'Phone',
      location: 'Mailing City',
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
      hq: 'Primary location > Country',
    },
    people: {
      name: 'Record',
      email: 'Email addresses',
      location: 'Primary location > Country',
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

  return map
}

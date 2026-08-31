import type { ConsentPurposeStatus } from '@kelpie/schemas'

/**
 * The purposes a new workspace starts with. Data, not migrations: a workspace
 * owner may rename, reorder, or delete them, and add any others they need.
 *
 * Both starters default to `unknown` — silence about a person's wishes is not
 * a grant, and every capture site (forms, lists, imports, manual override)
 * writes an explicit `person_consents` row when consent is actually given.
 */

export interface StarterConsentPurpose {
  readonly slug: string
  readonly label: string
  readonly description: string
  readonly defaultStatus: ConsentPurposeStatus
}

export const STARTER_CONSENT_PURPOSES: readonly StarterConsentPurpose[] = [
  {
    slug: 'contact',
    label: 'Contact',
    description: 'Being contacted by the workspace about our work together.',
    defaultStatus: 'unknown',
  },
  {
    slug: 'marketing',
    label: 'Marketing',
    description: 'Marketing communications — newsletters, product updates, and campaigns.',
    defaultStatus: 'unknown',
  },
]

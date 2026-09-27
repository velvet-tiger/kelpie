import type { ConsentPurposeStatus } from '@kelpie/schemas'

/**
 * The purposes a new workspace starts with. Data, not migrations: a workspace
 * owner may rename, reorder, or delete them, and add any others they need.
 *
 * Both starters default to `unknown` — silence about a person's wishes is not
 * a grant, and every capture site (forms, imports, manual override)
 * writes an explicit `person_consents` row when consent is actually given.
 */

export interface StarterConsentPurpose {
  readonly slug: string
  readonly label: string
  readonly description: string
  readonly statement: string
  readonly defaultStatus: ConsentPurposeStatus
}

export const STARTER_CONSENT_PURPOSES: readonly StarterConsentPurpose[] = [
  {
    slug: 'contact',
    label: 'Contact',
    description: 'Being contacted by the workspace about our work together.',
    statement:
      'I consent to {{workspace}} contacting me and retaining my information for the purpose of handling my enquiry.',
    defaultStatus: 'unknown',
  },
  {
    slug: 'marketing',
    label: 'Marketing',
    description: 'Marketing communications — newsletters, product updates, and campaigns.',
    statement: 'I consent to {{workspace}} retaining my information for marketing purposes.',
    defaultStatus: 'unknown',
  },
]

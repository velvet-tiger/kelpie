import type { HandbookTemplateId } from '@kelpie/schemas'

/**
 * Labels and descriptions for the organisation-type step. Page lists live
 * server-side; `later` maps to the startup (original) handbook template.
 */

export type OrganisationChoiceId = HandbookTemplateId | 'later'

export interface OrganisationChoice {
  readonly id: OrganisationChoiceId
  readonly label: string
  readonly description: string
}

export const ORGANISATION_CHOICES: readonly OrganisationChoice[] = [
  {
    id: 'startup',
    label: 'Startup',
    description: 'Product company, SaaS, or tech startup.',
  },
  {
    id: 'agency',
    label: 'Agency',
    description: 'Consultancy, design shop, dev shop, or marketing agency.',
  },
  {
    id: 'nonprofit',
    label: 'Nonprofit',
    description: 'Charity, foundation, or social enterprise.',
  },
  {
    id: 'community',
    label: 'Community',
    description: 'Club, association, co-op, or membership organisation.',
  },
  {
    id: 'professional-services',
    label: 'Professional services',
    description: 'Law, accounting, architecture, or advisory practice.',
  },
  {
    id: 'creator',
    label: 'Creator',
    description: 'Solo creator, freelancer, or personal brand.',
  },
  {
    id: 'later',
    label: 'Choose later',
    description: 'Use the standard startup handbook for now. Edit pages any time.',
  },
]

export const DEFAULT_ORGANISATION_CHOICE: OrganisationChoiceId = 'startup'

/** `later` seeds the original startup pages. */
export function handbookTemplateForChoice(choice: OrganisationChoiceId): HandbookTemplateId {
  return choice === 'later' ? 'startup' : choice
}

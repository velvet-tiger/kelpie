/**
 * The six optional modules the setup wizard offers. Other toggleable modules
 * stay on; Admin → Modules is where they change later.
 *
 * Ids match the server module catalog (`deals`, `raises`, …). The wizard is
 * what writes the first `workspace_module_settings` rows for these six.
 */

export interface OnboardingModuleChoice {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly defaultEnabled: boolean
}

export const ONBOARDING_MODULES: readonly OnboardingModuleChoice[] = [
  {
    id: 'deals',
    label: 'Deals',
    description: 'Track sales you are trying to close, from first chat to won or lost.',
    defaultEnabled: false,
  },
  {
    id: 'opportunities',
    label: 'Opportunities',
    description: 'Chase things that are not sales — grants, awards, press, a speaking slot.',
    defaultEnabled: true,
  },
  {
    id: 'raises',
    label: 'Fundraising',
    description: 'Run a funding round: who you are talking to, and where each one is up to.',
    defaultEnabled: false,
  },
  {
    id: 'partnerships',
    label: 'Partnerships',
    description: 'Keep tabs on the people you work with long-term, and when to check in next.',
    defaultEnabled: false,
  },
  {
    id: 'events',
    label: 'Events',
    description: 'Plan meetups, dinners, and webinars, and see who is coming.',
    defaultEnabled: true,
  },
  {
    id: 'forms',
    label: 'Forms',
    description: 'Put a form on your site. New sign-ups land in Kelpie on their own.',
    defaultEnabled: true,
  },
]

export function defaultOnboardingModuleState(): Record<string, boolean> {
  return Object.fromEntries(ONBOARDING_MODULES.map((choice) => [choice.id, choice.defaultEnabled]))
}

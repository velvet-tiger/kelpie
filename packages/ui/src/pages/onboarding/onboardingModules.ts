import type { OrganisationChoiceId } from './handbookTemplates.ts'

/**
 * The six optional modules the setup wizard offers. Other toggleable modules
 * stay on; Admin → Modules is where they change later.
 *
 * Ids match the server module catalog (`deals`, `raises`, …). The wizard is
 * what writes the first `workspace_module_settings` rows for these six.
 *
 * Labels stay the domain names. Defaults and explanations follow the
 * organisation type chosen on the previous step (`onboarding.md`).
 */

export type OnboardingModuleId =
  | 'deals'
  | 'opportunities'
  | 'raises'
  | 'partnerships'
  | 'events'
  | 'forms'

export interface OnboardingModuleChoice {
  readonly id: OnboardingModuleId
  readonly label: string
  readonly description: string
  readonly defaultEnabled: boolean
}

interface ModulePreset {
  readonly enabled: Readonly<Record<OnboardingModuleId, boolean>>
  readonly descriptions: Readonly<Record<OnboardingModuleId, string>>
}

const LABELS: Readonly<Record<OnboardingModuleId, string>> = {
  deals: 'Deals',
  opportunities: 'Opportunities',
  raises: 'Fundraising',
  partnerships: 'Partnerships',
  events: 'Events',
  forms: 'Forms',
}

const MODULE_ORDER: readonly OnboardingModuleId[] = [
  'deals',
  'opportunities',
  'raises',
  'partnerships',
  'events',
  'forms',
]

/** Startup / Choose later — every optional module starts on. */
const STARTUP: ModulePreset = {
  enabled: {
    deals: true,
    opportunities: true,
    raises: true,
    partnerships: true,
    events: true,
    forms: true,
  },
  descriptions: {
    deals: 'Track sales you are trying to close, from first chat to won or lost.',
    opportunities: 'Chase things that are not sales — grants, awards, press, a speaking slot.',
    raises: 'Run a funding round: who you are talking to, and where each one is up to.',
    partnerships: 'Keep tabs on the people you work with long-term, and when to check in next.',
    events: 'Plan meetups, dinners, and webinars, and see who is coming.',
    forms: 'Put a form on your site. New sign-ups land in Kelpie on their own.',
  },
}

const AGENCY: ModulePreset = {
  enabled: {
    deals: true,
    opportunities: false,
    raises: false,
    partnerships: true,
    events: true,
    forms: true,
  },
  descriptions: {
    deals: 'Track pitches, retainers, and projects you are trying to close.',
    opportunities: 'Chase RFPs, awards, press, and speaking slots that are not billed work.',
    raises: 'Run a funding round: who you are talking to, and where each one is up to.',
    partnerships: 'Keep tabs on subcontractors, channel partners, and when to check in next.',
    events: 'Plan workshops, client dinners, and webinars, and see who is coming.',
    forms: 'Put a form on your site. New enquiries land in Kelpie on their own.',
  },
}

const NONPROFIT: ModulePreset = {
  enabled: {
    deals: false,
    opportunities: true,
    raises: true,
    partnerships: true,
    events: true,
    forms: true,
  },
  descriptions: {
    deals: 'Track sponsorships or earned-income work you are trying to close.',
    opportunities: 'Chase grants, awards, press, and speaking slots.',
    raises: 'Track who you are raising from, and where each conversation is up to.',
    partnerships: 'Keep tabs on the organisations you work with long-term, and when to check in next.',
    events: 'Plan fundraisers, volunteer days, and community gatherings, and see who is coming.',
    forms: 'Put a form on your site. New supporters land in Kelpie on their own.',
  },
}

const COMMUNITY: ModulePreset = {
  enabled: {
    deals: false,
    opportunities: true,
    raises: true,
    partnerships: true,
    events: true,
    forms: true,
  },
  descriptions: {
    deals: 'Track sponsorships or paid programmes you are trying to close.',
    opportunities: 'Chase grants, press, and speaking slots that are not membership sales.',
    raises: 'Track who you are raising from, and where each conversation is up to.',
    partnerships: 'Keep tabs on sister organisations and long-term collaborators, and when to check in next.',
    events: 'Plan meetups, dinners, and member gatherings, and see who is coming.',
    forms: 'Put a join or contact form on your site. New sign-ups land in Kelpie on their own.',
  },
}

const PROFESSIONAL_SERVICES: ModulePreset = {
  enabled: {
    deals: true,
    opportunities: false,
    raises: false,
    partnerships: false,
    events: true,
    forms: true,
  },
  descriptions: {
    deals: 'Track engagements from first conversation to won or lost.',
    opportunities: 'Chase tenders, panels, press, and speaking slots.',
    raises: 'Run a funding round: who you are talking to, and where each one is up to.',
    partnerships: 'Keep tabs on referral sources and when to check in next.',
    events: 'Plan client seminars, dinners, and webinars, and see who is coming.',
    forms: 'Put a form on your site. New enquiries land in Kelpie on their own.',
  },
}

const CREATOR: ModulePreset = {
  enabled: {
    deals: true,
    opportunities: true,
    raises: false,
    partnerships: false,
    events: false,
    forms: true,
  },
  descriptions: {
    deals: 'Track brand deals and client work from first chat to won or lost.',
    opportunities: 'Chase press, speaking, and other chances that are not billed work.',
    raises: 'Run a funding round: who you are talking to, and where each one is up to.',
    partnerships: 'Keep tabs on the brands you work with long-term, and when to check in next.',
    events: 'Plan meetups, launches, and webinars, and see who is coming.',
    forms: 'Put a form on your site. New enquiries land in Kelpie on their own.',
  },
}

const PRESETS: Readonly<Record<Exclude<OrganisationChoiceId, 'later'>, ModulePreset>> = {
  startup: STARTUP,
  agency: AGENCY,
  nonprofit: NONPROFIT,
  community: COMMUNITY,
  'professional-services': PROFESSIONAL_SERVICES,
  creator: CREATOR,
}

function presetForChoice(choice: OrganisationChoiceId): ModulePreset {
  return choice === 'later' ? STARTUP : PRESETS[choice]
}

/** Startup catalog. Prefer `onboardingModulesForChoice` when a type is known. */
export const ONBOARDING_MODULES: readonly OnboardingModuleChoice[] = modulesFromPreset(STARTUP)

export function onboardingModulesForChoice(
  choice: OrganisationChoiceId,
): readonly OnboardingModuleChoice[] {
  return modulesFromPreset(presetForChoice(choice))
}

export function defaultOnboardingModuleState(
  choice: OrganisationChoiceId = 'startup',
): Record<OnboardingModuleId, boolean> {
  return { ...presetForChoice(choice).enabled }
}

function modulesFromPreset(preset: ModulePreset): readonly OnboardingModuleChoice[] {
  return MODULE_ORDER.map((id) => ({
    id,
    label: LABELS[id],
    description: preset.descriptions[id],
    defaultEnabled: preset.enabled[id],
  }))
}

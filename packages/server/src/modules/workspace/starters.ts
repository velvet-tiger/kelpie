/**
 * What a new workspace starts with, per `onboarding.md` step 4 and the seeding
 * rule in `schema.md`.
 *
 * Both lists are data, not migrations: they are per-workspace rows a workspace
 * owner can then rename, reorder, or delete.
 */

export interface StarterHandbookPage {
  readonly title: string
  readonly slug: string
}

/** Bodies start as stubs. Teams write them; agents read whatever is there. */
export const STARTER_HANDBOOK_PAGES: readonly StarterHandbookPage[] = [
  { title: 'About us', slug: 'about-us' },
  { title: 'Product', slug: 'product' },
  { title: 'Ideal customer profile', slug: 'ideal-customer-profile' },
  { title: 'Voice and tone', slug: 'voice-and-tone' },
  { title: 'Pricing', slug: 'pricing' },
  { title: 'How we sell', slug: 'how-we-sell' },
  { title: 'Competitive landscape', slug: 'competitive-landscape' },
  { title: 'Team and roles', slug: 'team-and-roles' },
  { title: 'Tools and stack', slug: 'tools-and-stack' },
  { title: 'Agent FAQ', slug: 'agent-faq' },
]

export function starterHandbookBody(title: string): string {
  return `# ${title}\n\nWrite this page.`
}

export interface StarterStage {
  readonly slug: string
  readonly label: string
  readonly open: boolean
}

/** `open: false` hides a stage from the Open scope filter; it is not a delete. */
export const STARTER_PIPELINE_STAGES: Readonly<Record<string, readonly StarterStage[]>> = {
  deal: [
    { slug: 'qualifying', label: 'Qualifying', open: true },
    { slug: 'proposal', label: 'Proposal', open: true },
    { slug: 'negotiation', label: 'Negotiation', open: true },
    { slug: 'won', label: 'Won', open: false },
    { slug: 'lost', label: 'Lost', open: false },
  ],
  opportunity: [
    { slug: 'identified', label: 'Identified', open: true },
    { slug: 'applied', label: 'Applied', open: true },
    { slug: 'interview', label: 'Interview', open: true },
    { slug: 'won', label: 'Won', open: false },
    { slug: 'passed', label: 'Passed', open: false },
  ],
  raise: [
    { slug: 'researching', label: 'Researching', open: true },
    { slug: 'intro', label: 'Intro', open: true },
    { slug: 'meeting', label: 'Meeting', open: true },
    { slug: 'diligence', label: 'Diligence', open: true },
    { slug: 'term_sheet', label: 'Term sheet', open: true },
    { slug: 'closed', label: 'Closed', open: false },
    { slug: 'passed', label: 'Passed', open: false },
  ],
  partnership: [
    { slug: 'exploring', label: 'Exploring', open: true },
    { slug: 'active', label: 'Active', open: true },
    { slug: 'paused', label: 'Paused', open: true },
    { slug: 'ended', label: 'Ended', open: false },
  ],
}

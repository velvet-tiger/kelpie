/**
 * What a new workspace starts with, per `onboarding.md` step 4 and the seeding
 * rule in `schema.md`.
 *
 * Both lists are data, not migrations: they are per-workspace rows a workspace
 * owner can then rename, reorder, or delete.
 */

export const HANDBOOK_TEMPLATE_IDS = [
  'startup',
  'agency',
  'nonprofit',
  'community',
  'professional-services',
  'creator',
] as const

export type HandbookTemplateId = (typeof HANDBOOK_TEMPLATE_IDS)[number]

export interface StarterHandbookPage {
  readonly title: string
  readonly slug: string
  readonly bodyPrompt: string
}

export interface HandbookTemplate {
  readonly id: HandbookTemplateId
  readonly label: string
  readonly description: string
  readonly pages: readonly StarterHandbookPage[]
}

function page(title: string, slug: string, bodyPrompt: string): StarterHandbookPage {
  return { title, slug, bodyPrompt }
}

const STARTUP_PAGES: readonly StarterHandbookPage[] = [
  page('About us', 'about-us', 'What does your company do, and why does it exist?'),
  page('Product', 'product', 'What do you sell, and what problem does it solve?'),
  page(
    'Ideal customer profile',
    'ideal-customer-profile',
    'Who is your best-fit customer? Size, industry, pain points, and buying signals.',
  ),
  page('Voice and tone', 'voice-and-tone', 'How should Kelpie and your agents sound when they write on your behalf?'),
  page('Pricing', 'pricing', 'How is your product priced? Plans, tiers, and what is included.'),
  page('How we sell', 'how-we-sell', 'Your sales motion: inbound, outbound, trials, demos, and typical cycle.'),
  page(
    'Competitive landscape',
    'competitive-landscape',
    'Who else solves this problem, and why do customers choose you over them?',
  ),
  page('Team and roles', 'team-and-roles', 'Who does what, and who owns which relationships or decisions?'),
  page('Tools and stack', 'tools-and-stack', 'The systems your team and agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

const AGENCY_PAGES: readonly StarterHandbookPage[] = [
  page('About us', 'about-us', 'What does your agency do, and what makes your team distinctive?'),
  page(
    'Services & capabilities',
    'product',
    'What services do you offer, and what kinds of clients or projects fit best?',
  ),
  page(
    'Ideal client profile',
    'ideal-customer-profile',
    'Who is your best-fit client? Size, sector, budget, and the problems you solve best.',
  ),
  page('Voice and tone', 'voice-and-tone', 'How should Kelpie and your agents sound in client-facing writing?'),
  page(
    'Pricing & engagement models',
    'pricing',
    'How you price work: retainers, fixed bids, day rates, and typical scopes.',
  ),
  page('How we win work', 'how-we-sell', 'How you find and close clients: referrals, pitches, RFPs, and follow-up.'),
  page(
    'Competitive landscape',
    'competitive-landscape',
    'Who you compete with, and why clients choose you over alternatives.',
  ),
  page(
    'Case studies & proof points',
    'case-studies',
    'Outcomes you can cite: client wins, metrics, and stories agents may reference.',
  ),
  page(
    'How we deliver work',
    'delivery-process',
    'How a project runs from kickoff to handoff: phases, checkpoints, and client touchpoints.',
  ),
  page('Team and roles', 'team-and-roles', 'Who leads delivery, sales, and client relationships?'),
  page('Tools and stack', 'tools-and-stack', 'The systems your team and agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

const NONPROFIT_PAGES: readonly StarterHandbookPage[] = [
  page('About us & mission', 'about-us', 'Your mission, vision, and the change you exist to make.'),
  page(
    'Programs & impact',
    'product',
    'What programs or services you run, and what outcomes they aim for.',
  ),
  page(
    'Who we serve',
    'ideal-customer-profile',
    'The communities, beneficiaries, or stakeholders your programs exist for.',
  ),
  page('Voice and tone', 'voice-and-tone', 'How should Kelpie and your agents sound when they write on your behalf?'),
  page(
    'How we engage supporters',
    'how-we-sell',
    'How you build relationships with donors, volunteers, partners, and the public.',
  ),
  page(
    'Funding & donations',
    'funding-and-donations',
    'Revenue streams: donations, grants, memberships, and major-gift approaches.',
  ),
  page('Impact & outcomes', 'impact-metrics', 'How you measure success: outputs, outcomes, and stories you can cite.'),
  page(
    'Grant applications',
    'grant-applications',
    'How you find, qualify, and apply for grants; common requirements and deadlines.',
  ),
  page('Team and roles', 'team-and-roles', 'Who does what, and who owns programs, fundraising, and comms?'),
  page('Tools and stack', 'tools-and-stack', 'The systems your team and agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

const COMMUNITY_PAGES: readonly StarterHandbookPage[] = [
  page('About us', 'about-us', 'What your organisation is, its purpose, and who it serves.'),
  page('What we offer', 'product', 'What members get: benefits, services, events, and community value.'),
  page(
    'Ideal member profile',
    'ideal-customer-profile',
    'Who should join, and what makes someone a good fit for your community?',
  ),
  page('Voice and tone', 'voice-and-tone', 'How should Kelpie and your agents sound when they write on your behalf?'),
  page('Membership & fees', 'pricing', 'Membership tiers, fees, and what each level includes.'),
  page(
    'How we grow membership',
    'how-we-sell',
    'How you attract and retain members: outreach, events, referrals, and renewals.',
  ),
  page('Membership benefits', 'membership-benefits', 'What members receive: access, discounts, resources, and perks.'),
  page(
    'Events & programming',
    'events-and-programming',
    'Regular events, programs, and how members can participate.',
  ),
  page('Team and roles', 'team-and-roles', 'Who runs the organisation, and who owns membership and events?'),
  page('Tools and stack', 'tools-and-stack', 'The systems your team and agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

const PROFESSIONAL_SERVICES_PAGES: readonly StarterHandbookPage[] = [
  page('About the practice', 'about-us', 'What your practice does, its history, and what distinguishes it.'),
  page('Practice areas', 'product', 'The services and matters you handle, and what you do not take on.'),
  page(
    'Ideal client profile',
    'ideal-customer-profile',
    'Who your best-fit clients are: size, sector, matter types, and engagement style.',
  ),
  page('Voice and tone', 'voice-and-tone', 'How should Kelpie and your agents sound in client-facing writing?'),
  page('Fee structures', 'pricing', 'How you charge: hourly, fixed, value-based, and typical ranges.'),
  page(
    'Business development',
    'how-we-sell',
    'How you win clients: referrals, networking, pitches, and follow-up.',
  ),
  page('Market position', 'competitive-landscape', 'How you compare to peer firms and why clients choose you.'),
  page(
    'Conflicts & ethics',
    'conflicts-and-ethics',
    'Conflict checks, ethical boundaries, and what agents must never assume or promise.',
  ),
  page('Team and roles', 'team-and-roles', 'Partners, associates, and who owns client relationships.'),
  page('Tools and stack', 'tools-and-stack', 'The systems your team and agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

const CREATOR_PAGES: readonly StarterHandbookPage[] = [
  page('About me', 'about-us', 'Who you are, what you create, and what your brand stands for.'),
  page('What I create', 'product', 'Your content, products, or services, and what makes them distinctive.'),
  page(
    'Audience profile',
    'ideal-customer-profile',
    'Who follows you, who buys from you, and what they care about.',
  ),
  page('Voice and tone', 'voice-and-tone', 'How you sound across content, email, and brand partnerships.'),
  page('Rates & packages', 'pricing', 'What you charge: sponsorship rates, consulting packages, and deliverables.'),
  page(
    'How I work with clients',
    'how-we-sell',
    'How inbound leads become paid work: discovery, scope, contracts, and delivery.',
  ),
  page(
    'Brand partnerships & sponsorships',
    'brand-partnerships',
    'What you offer sponsors, your rates, and brands you will or will not work with.',
  ),
  page('Tools and stack', 'tools-and-stack', 'The systems you and your agents should know about.'),
  page(
    'Agent FAQ',
    'agent-faq',
    'Standing rules for agents: what they may promise, what they must escalate, and what never to invent.',
  ),
]

export const HANDBOOK_TEMPLATES: Readonly<Record<HandbookTemplateId, HandbookTemplate>> = {
  startup: {
    id: 'startup',
    label: 'Startup',
    description: 'Product company, SaaS, or tech startup selling software or services.',
    pages: STARTUP_PAGES,
  },
  agency: {
    id: 'agency',
    label: 'Agency',
    description: 'Consultancy, design shop, dev shop, or marketing agency.',
    pages: AGENCY_PAGES,
  },
  nonprofit: {
    id: 'nonprofit',
    label: 'Nonprofit',
    description: 'Charity, foundation, or social enterprise.',
    pages: NONPROFIT_PAGES,
  },
  community: {
    id: 'community',
    label: 'Community',
    description: 'Club, association, co-op, or membership organisation.',
    pages: COMMUNITY_PAGES,
  },
  'professional-services': {
    id: 'professional-services',
    label: 'Professional services',
    description: 'Law, accounting, architecture, or advisory practice.',
    pages: PROFESSIONAL_SERVICES_PAGES,
  },
  creator: {
    id: 'creator',
    label: 'Creator',
    description: 'Solo creator, freelancer, or personal brand.',
    pages: CREATOR_PAGES,
  },
}

/** Default startup template pages — same list `onboarding.md` names. */
export const STARTER_HANDBOOK_PAGES: readonly StarterHandbookPage[] = STARTUP_PAGES

export function isStarterHandbookBody(page: { readonly slug: string; readonly body: string }): boolean {
  for (const template of Object.values(HANDBOOK_TEMPLATES)) {
    for (const def of template.pages) {
      if (def.slug === page.slug && starterHandbookBody(def) === page.body) {
        return true
      }
    }
  }

  return false
}

export function getHandbookPagesForTemplate(templateId: HandbookTemplateId): readonly StarterHandbookPage[] {
  return HANDBOOK_TEMPLATES[templateId].pages
}

export function starterHandbookBody(page: StarterHandbookPage): string {
  return `# ${page.title}\n\n${page.bodyPrompt}`
}

export interface StarterStage {
  readonly slug: string
  readonly label: string
  readonly open: boolean
}

/** `open: false` hides a stage from the Open scope filter; it is not a delete. */
export const STARTER_PIPELINE_STAGES: Readonly<Record<string, readonly StarterStage[]>> = {
  enquiry: [
    { slug: 'new', label: 'New', open: true },
    { slug: 'in_progress', label: 'In progress', open: true },
    { slug: 'closed', label: 'Closed', open: false },
  ],
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

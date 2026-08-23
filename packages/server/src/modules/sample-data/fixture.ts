import type { AccountType, CompanyStage, IcpFit, SizeBand } from '@kelpie/schemas'
import type { CandidateStatus, InterviewStage, RoleStatus } from '@kelpie/schemas'
import type { Influence, PreferredChannel, Relationship } from '@kelpie/schemas'
import type { PipelineKind, PlanItemStatus, RecordTargetType } from '@kelpie/schemas'

/**
 * The sample workspace, as a self-contained fixture.
 *
 * Cross-record links use string keys (`companyKey`, `personKey`, `dealKey`),
 * not ids. The installer resolves them into real ids at insert time. This is
 * data, not migrations: a workspace owner may delete or edit any row later.
 *
 * Kept small on purpose. A reader should be able to see the whole company in one
 * scroll, and a workspace clearing it out should not be a chore.
 */

export interface FixtureCompany {
  readonly key: string
  readonly name: string
  readonly domain: string | null
  readonly industry: string | null
  readonly description: string
  readonly stage: CompanyStage
  readonly sizeBand: SizeBand
  readonly hq: string | null
  readonly website: string | null
  readonly accountType: AccountType
  readonly icpFit: IcpFit
  readonly techStack: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
}

export interface FixturePerson {
  readonly key: string
  readonly name: string
  readonly email: string | null
  readonly location: string | null
  readonly preferredChannel: PreferredChannel
  readonly influence: Influence
  readonly relationship: Relationship
  readonly summary: string
  readonly tags: readonly string[]
}

export interface FixturePosition {
  readonly personKey: string
  readonly companyKey: string
  readonly title: string
}

export interface FixtureDeal {
  readonly key: string
  readonly name: string
  readonly companyKey: string
  readonly stageSlug: string
  readonly valueCents: number | null
  readonly currency: string | null
  readonly expectedClose: string | null
  readonly whyWin: string
  readonly risks: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly peopleKeys: readonly string[]
}

export interface FixturePlanItem {
  readonly targetType: PipelineKind
  readonly targetDealKey: string
  readonly date: string
  readonly title: string
  readonly status: PlanItemStatus
}

export interface FixtureNote {
  readonly targetType: RecordTargetType
  readonly targetKey: string
  readonly body: string
  readonly pinned: boolean
}

export interface FixtureOpportunity {
  readonly key: string
  readonly name: string
  readonly kind: string
  readonly stageSlug: string
  /** Nullable: a grant or speaking slot need not belong to a company on file. */
  readonly companyKey: string | null
  readonly expectedClose: string | null
  readonly summary: string
  readonly tags: readonly string[]
}

export interface FixtureRaise {
  readonly key: string
  readonly name: string
  readonly companyKey: string
  readonly stageSlug: string
  readonly checkSizeCents: number | null
  readonly currency: string | null
  readonly thesisFit: string
  readonly expectedClose: string | null
  readonly summary: string
  readonly tags: readonly string[]
  readonly peopleKeys: readonly string[]
}

export interface FixturePartnership {
  readonly key: string
  readonly name: string
  readonly companyKey: string
  readonly stageSlug: string
  readonly kind: string
  readonly nextTouchpoint: string | null
  readonly goals: string
  readonly successLooksLike: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly peopleKeys: readonly string[]
}

export interface FixtureRole {
  readonly key: string
  readonly title: string
  readonly status: RoleStatus
}

export interface FixtureCandidate {
  readonly key: string
  readonly personKey: string
  readonly roleKey: string
  readonly status: CandidateStatus
  /** Only set when `status` is `in_process`. Other statuses clear it. */
  readonly interviewStage: InterviewStage | null
  readonly referrerPersonKey: string | null
}

export interface Fixture {
  readonly companies: readonly FixtureCompany[]
  readonly people: readonly FixturePerson[]
  readonly positions: readonly FixturePosition[]
  readonly deals: readonly FixtureDeal[]
  readonly plans: readonly FixturePlanItem[]
  readonly notes: readonly FixtureNote[]
  readonly opportunities: readonly FixtureOpportunity[]
  readonly raises: readonly FixtureRaise[]
  readonly partnerships: readonly FixturePartnership[]
  readonly roles: readonly FixtureRole[]
  readonly candidates: readonly FixtureCandidate[]
}

export const SAMPLE_DATA_FIXTURE: Fixture = {
  companies: [
    {
      key: 'northwind',
      name: 'Northwind Traders',
      domain: 'northwind.dev',
      industry: 'Logistics software',
      description: 'Freight forwarding platform for mid-market importers.',
      stage: 'growth',
      sizeBand: '51-200',
      hq: 'Melbourne, AU',
      website: 'https://northwind.dev',
      accountType: 'customer',
      icpFit: 'high',
      techStack: ['Postgres', 'Node', 'React'],
      summary: 'Active customer. Two seats, expanding to five in Q3.',
      tags: ['customer', 'expansion'],
    },
    {
      key: 'globex',
      name: 'Globex Corporation',
      domain: 'globex.example',
      industry: 'Manufacturing',
      description: 'Industrial IoT platform for factory operators.',
      stage: 'enterprise',
      sizeBand: '201+',
      hq: 'Sydney, AU',
      website: 'https://globex.example',
      accountType: 'prospect',
      icpFit: 'medium',
      techStack: ['Java', 'Kafka'],
      summary: 'Qualifying. Legal review is the current gate.',
      tags: ['enterprise'],
    },
    {
      key: 'initech',
      name: 'Initech',
      domain: 'initech.example',
      industry: 'Financial services',
      description: 'Accounts payable automation for SMBs.',
      stage: 'startup',
      sizeBand: '11-50',
      hq: 'Brisbane, AU',
      website: 'https://initech.example',
      accountType: 'prospect',
      icpFit: 'high',
      techStack: ['Python', 'Postgres'],
      summary: 'Inbound from the demo form last week.',
      tags: ['inbound'],
    },
    {
      key: 'hooli',
      name: 'Hooli',
      domain: 'hooli.example',
      industry: 'Consumer platform',
      description: 'Search and discovery for local services.',
      stage: 'growth',
      sizeBand: '51-200',
      hq: 'Perth, AU',
      website: 'https://hooli.example',
      accountType: 'partner',
      icpFit: 'medium',
      techStack: ['Go', 'gRPC'],
      summary: 'Referral partner. Sends two or three inbound leads a month.',
      tags: ['partner'],
    },
    {
      key: 'stark',
      name: 'Stark Industries',
      domain: 'stark.example',
      industry: 'Aerospace',
      description: 'Contract manufacturing for defence primes.',
      stage: 'enterprise',
      sizeBand: '201+',
      hq: 'Adelaide, AU',
      website: 'https://stark.example',
      accountType: 'prospect',
      icpFit: 'low',
      techStack: [],
      summary: 'Not a fit today. Keep warm for a future compliance module.',
      tags: ['not-a-fit'],
    },
    {
      key: 'sequoia',
      name: 'Southern Cross Ventures',
      domain: 'southerncross.example',
      industry: 'Venture capital',
      description: 'Seed-stage investor, one to five million cheque size.',
      stage: 'other',
      sizeBand: '11-50',
      hq: 'Sydney, AU',
      website: 'https://southerncross.example',
      accountType: 'investor',
      icpFit: 'unknown',
      techStack: [],
      summary: 'Warm intro from a portfolio founder in June.',
      tags: ['investor'],
    },
    {
      key: 'sandbox',
      name: 'Sandbox Accelerator',
      domain: 'sandbox.example',
      industry: 'Startup accelerator',
      description: 'Twelve week program with a demo day and alumni network.',
      stage: 'other',
      sizeBand: '11-50',
      hq: 'Melbourne, AU',
      website: 'https://sandbox.example',
      accountType: 'partner',
      icpFit: 'unknown',
      techStack: [],
      summary: 'Alumni of the 2024 cohort. Runs regular founder events.',
      tags: ['accelerator'],
    },
  ],

  people: [
    {
      key: 'ada',
      name: 'Ada Lovelace',
      email: 'ada@northwind.dev',
      location: 'Melbourne, AU',
      preferredChannel: 'email',
      influence: 'champion',
      relationship: 'strong',
      summary: 'Executive sponsor at Northwind. Signs off on renewals.',
      tags: ['champion'],
    },
    {
      key: 'grace',
      name: 'Grace Hopper',
      email: 'grace@northwind.dev',
      location: 'Melbourne, AU',
      preferredChannel: 'email',
      influence: 'influencer',
      relationship: 'warm',
      summary: 'Operations lead at Northwind. Day-to-day contact.',
      tags: [],
    },
    {
      key: 'tom',
      name: 'Tom Anderson',
      email: 'tom@globex.example',
      location: 'Sydney, AU',
      preferredChannel: 'call',
      influence: 'decision_maker',
      relationship: 'warm',
      summary: 'Head of engineering at Globex. Decision maker on the qualifying deal.',
      tags: ['decision-maker'],
    },
    {
      key: 'peter',
      name: 'Peter Gibbons',
      email: 'peter@initech.example',
      location: 'Brisbane, AU',
      preferredChannel: 'email',
      influence: 'influencer',
      relationship: 'warm',
      summary: 'Product manager at Initech. Filled in the demo form.',
      tags: ['inbound'],
    },
    {
      key: 'gavin',
      name: 'Gavin Belson',
      email: 'gavin@hooli.example',
      location: 'Perth, AU',
      preferredChannel: 'linkedin',
      influence: 'decision_maker',
      relationship: 'warm',
      summary: 'Partnerships lead at Hooli. Introduced Initech last month.',
      tags: ['partner'],
    },
    {
      key: 'roelof',
      name: 'Roelof Nkosi',
      email: 'roelof@southerncross.example',
      location: 'Sydney, AU',
      preferredChannel: 'email',
      influence: 'decision_maker',
      relationship: 'warm',
      summary: 'Partner at Southern Cross. Leading the diligence on our seed round.',
      tags: ['investor'],
    },
    {
      key: 'mei',
      name: 'Mei Zhang',
      email: 'mei@sandbox.example',
      location: 'Melbourne, AU',
      preferredChannel: 'email',
      influence: 'influencer',
      relationship: 'warm',
      summary: 'Program director at Sandbox. Runs the alumni network.',
      tags: ['partner'],
    },
    {
      key: 'charlotte',
      name: 'Charlotte Rivera',
      email: 'charlotte@example.com',
      location: 'Melbourne, AU',
      preferredChannel: 'email',
      influence: 'end_user',
      relationship: 'warm',
      summary: 'Backend engineer applying for the senior role. Strong TypeScript background.',
      tags: ['candidate'],
    },
    {
      key: 'omar',
      name: 'Omar Haddad',
      email: 'omar@example.com',
      location: 'Sydney, AU',
      preferredChannel: 'email',
      influence: 'end_user',
      relationship: 'cold',
      summary: 'Product designer, sourced through the Sandbox alumni list.',
      tags: ['candidate'],
    },
  ],

  positions: [
    { personKey: 'ada', companyKey: 'northwind', title: 'CEO' },
    { personKey: 'grace', companyKey: 'northwind', title: 'Head of Operations' },
    { personKey: 'tom', companyKey: 'globex', title: 'VP Engineering' },
    { personKey: 'peter', companyKey: 'initech', title: 'Product Manager' },
    { personKey: 'gavin', companyKey: 'hooli', title: 'Head of Partnerships' },
    { personKey: 'roelof', companyKey: 'sequoia', title: 'Partner' },
    { personKey: 'mei', companyKey: 'sandbox', title: 'Program Director' },
  ],

  deals: [
    {
      key: 'northwind-expansion',
      name: 'Northwind — seat expansion',
      companyKey: 'northwind',
      stageSlug: 'proposal',
      valueCents: 4_800_000,
      currency: 'AUD',
      expectedClose: nextQuarterEnd(),
      whyWin: 'Active customer, executive sponsor, adding three teams.',
      risks: 'Procurement wants a two-year commit at the current per-seat rate.',
      summary: 'Expansion from two to five seats.',
      tags: ['expansion'],
      peopleKeys: ['ada', 'grace'],
    },
    {
      key: 'globex-new',
      name: 'Globex — new logo',
      companyKey: 'globex',
      stageSlug: 'qualifying',
      valueCents: 12_000_000,
      currency: 'AUD',
      expectedClose: nextQuarterEnd(),
      whyWin: 'Replaces a bespoke tool their engineering team already resents.',
      risks: 'Legal redlines around data residency.',
      summary: 'Qualifying. Legal is the gate.',
      tags: ['enterprise'],
      peopleKeys: ['tom'],
    },
    {
      key: 'initech-new',
      name: 'Initech — pilot',
      companyKey: 'initech',
      stageSlug: 'qualifying',
      valueCents: 1_800_000,
      currency: 'AUD',
      expectedClose: null,
      whyWin: 'Inbound. Product manager already sold internally.',
      risks: 'Small team. Budget is not confirmed.',
      summary: 'Inbound from the demo form.',
      tags: ['inbound'],
      peopleKeys: ['peter'],
    },
  ],

  plans: [
    {
      targetType: 'deal',
      targetDealKey: 'northwind-expansion',
      date: aWeekOut(),
      title: 'Send revised order form',
      status: 'todo',
    },
    {
      targetType: 'deal',
      targetDealKey: 'globex-new',
      date: aWeekOut(),
      title: 'Reply to legal on data residency',
      status: 'todo',
    },
    {
      targetType: 'deal',
      targetDealKey: 'initech-new',
      date: threeDaysOut(),
      title: 'Book a 30-minute discovery call',
      status: 'todo',
    },
  ],

  notes: [
    {
      targetType: 'company',
      targetKey: 'northwind',
      body: 'Renewal cycle in October. Ada asked for a joint success plan.',
      pinned: true,
    },
    {
      targetType: 'deal',
      targetKey: 'globex-new',
      body: 'Tom prefers a call. Book Wednesday afternoons.',
      pinned: false,
    },
    {
      targetType: 'person',
      targetKey: 'peter',
      body: 'Attended the June webinar. Watched the follow-up demo twice.',
      pinned: false,
    },
    {
      targetType: 'raise',
      targetKey: 'southern-cross-seed',
      body: 'Roelof asked for the updated deck and the last two months of MRR.',
      pinned: true,
    },
    {
      targetType: 'partnership',
      targetKey: 'sandbox-alumni',
      body: 'Mei can slot us into the next alumni dinner in September.',
      pinned: false,
    },
    {
      targetType: 'candidate',
      targetKey: 'charlotte-senior-engineer',
      body: 'Screen call went well. Move to interview loop next week.',
      pinned: false,
    },
  ],

  opportunities: [
    {
      key: 'yc-w27',
      name: 'Y Combinator W27 application',
      kind: 'Accelerator',
      stageSlug: 'applied',
      companyKey: null,
      expectedClose: nextQuarterEnd(),
      summary: 'Applied October last cycle. Interview invitations go out in six weeks.',
      tags: ['accelerator'],
    },
    {
      key: 'sandbox-cohort',
      name: 'Sandbox Autumn Cohort',
      kind: 'Accelerator',
      stageSlug: 'identified',
      companyKey: 'sandbox',
      expectedClose: null,
      summary: 'Program starts in March. Mei suggested we apply this round.',
      tags: ['accelerator'],
    },
    {
      key: 'innovation-grant',
      name: 'Innovation Australia grant',
      kind: 'Grant',
      stageSlug: 'identified',
      companyKey: null,
      expectedClose: nextQuarterEnd(),
      summary: 'Non-dilutive. Up to $500k. Application window opens next month.',
      tags: ['grant'],
    },
  ],

  raises: [
    {
      key: 'southern-cross-seed',
      name: 'Southern Cross — Seed',
      companyKey: 'sequoia',
      stageSlug: 'diligence',
      checkSizeCents: 200_000_000,
      currency: 'AUD',
      thesisFit: 'Focus on developer tools and vertical SaaS. Strong fit for Kelpie.',
      expectedClose: nextQuarterEnd(),
      summary: 'Diligence in progress. Reference calls scheduled next week.',
      tags: ['seed'],
      peopleKeys: ['roelof'],
    },
  ],

  partnerships: [
    {
      key: 'hooli-referral',
      name: 'Hooli — referral partner',
      companyKey: 'hooli',
      stageSlug: 'active',
      kind: 'Referral',
      nextTouchpoint: aWeekOut(),
      goals: 'Two to three inbound leads per month.',
      successLooksLike: 'Steady referrals plus one joint case study by end of quarter.',
      summary: 'Active. Gavin is the day-to-day contact.',
      tags: ['referral'],
      peopleKeys: ['gavin'],
    },
    {
      key: 'sandbox-alumni',
      name: 'Sandbox — alumni network',
      companyKey: 'sandbox',
      stageSlug: 'exploring',
      kind: 'Community',
      nextTouchpoint: aWeekOut(),
      goals: 'Access alumni events and demo day slots.',
      successLooksLike: 'One demo day slot per year plus warm intros into portfolio.',
      summary: 'Exploring. Mei can slot us into the next alumni dinner.',
      tags: ['community'],
      peopleKeys: ['mei'],
    },
  ],

  roles: [
    { key: 'senior-engineer', title: 'Senior Software Engineer', status: 'open' },
    { key: 'product-designer', title: 'Product Designer', status: 'open' },
  ],

  candidates: [
    {
      key: 'charlotte-senior-engineer',
      personKey: 'charlotte',
      roleKey: 'senior-engineer',
      status: 'in_process',
      interviewStage: 'screen',
      referrerPersonKey: null,
    },
    {
      key: 'omar-product-designer',
      personKey: 'omar',
      roleKey: 'product-designer',
      status: 'in_process',
      interviewStage: 'sourced',
      referrerPersonKey: 'mei',
    },
    {
      key: 'peter-senior-engineer',
      personKey: 'peter',
      roleKey: 'senior-engineer',
      status: 'nurture',
      interviewStage: null,
      referrerPersonKey: null,
    },
  ],
}

/**
 * The last day of the current calendar quarter, as `YYYY-MM-DD`.
 *
 * A fixture that hardcoded a date would age. This keeps the deal in a
 * plausible future window without asking the caller to keep it fresh.
 */
function nextQuarterEnd(): string {
  const now = new Date()
  const quarter = Math.floor(now.getUTCMonth() / 3)
  const lastMonth = quarter * 3 + 2
  const year = now.getUTCFullYear()
  const end = new Date(Date.UTC(year, lastMonth + 1, 0))

  return end.toISOString().slice(0, 10)
}

function aWeekOut(): string {
  const now = new Date()
  now.setUTCDate(now.getUTCDate() + 7)

  return now.toISOString().slice(0, 10)
}

function threeDaysOut(): string {
  const now = new Date()
  now.setUTCDate(now.getUTCDate() + 3)

  return now.toISOString().slice(0, 10)
}

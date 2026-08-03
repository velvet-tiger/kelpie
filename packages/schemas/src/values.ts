/**
 * Fixed value sets shared by the wire schemas and by any UI that renders a
 * dropdown over one.
 *
 * This is the only copy. `@kelpie/server`'s module schemas import from here and
 * re-export, so one array drives a table's check constraint, the route's Zod
 * enum, and the browser's decoder. The dependency runs one way: the server may
 * import this package, and this package depends on Zod and nothing else, which
 * is what keeps it usable from a browser bundle and from the cloud repo.
 */

export const PREFERRED_CHANNELS = ['email', 'call', 'linkedin'] as const
export const INFLUENCE_LEVELS = [
  'champion',
  'decision_maker',
  'influencer',
  'blocker',
  'end_user',
] as const
export const RELATIONSHIP_LEVELS = ['cold', 'warm', 'strong'] as const

export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number]
export type Influence = (typeof INFLUENCE_LEVELS)[number]
export type Relationship = (typeof RELATIONSHIP_LEVELS)[number]

export const COMPANY_STAGES = ['startup', 'growth', 'enterprise', 'other'] as const
export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201+'] as const
export const ACCOUNT_TYPES = ['prospect', 'customer', 'partner', 'investor', 'other'] as const
export const ICP_FITS = ['high', 'medium', 'low', 'unknown'] as const

export type CompanyStage = (typeof COMPANY_STAGES)[number]
export type SizeBand = (typeof SIZE_BANDS)[number]
export type AccountType = (typeof ACCOUNT_TYPES)[number]
export type IcpFit = (typeof ICP_FITS)[number]

/** Networks a person can be linked on. One list beats a column per network. */
export const SOCIAL_NETWORK_IDS = [
  'angellist',
  'bluesky',
  'crunchbase',
  'facebook',
  'github',
  'instagram',
  'linkedin',
  'mastodon',
  'medium',
  'substack',
  'threads',
  'tiktok',
  'twitter',
  'youtube',
  'other',
] as const

export type SocialNetworkId = (typeof SOCIAL_NETWORK_IDS)[number]

/** Display names for `SOCIAL_NETWORK_IDS`, in the same order. */
export const SOCIAL_NETWORK_LABELS: Readonly<Record<SocialNetworkId, string>> = {
  angellist: 'AngelList',
  bluesky: 'Bluesky',
  crunchbase: 'Crunchbase',
  facebook: 'Facebook',
  github: 'GitHub',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  medium: 'Medium',
  substack: 'Substack',
  threads: 'Threads',
  tiktok: 'TikTok',
  twitter: 'X / Twitter',
  youtube: 'YouTube',
  other: 'Other',
}

/**
 * The record types a detail page exists for, and therefore the ones a UI module
 * can add a tab or a sidebar card to. Lived in `@kelpie/ui` until this package
 * gave it a home both the UI and the cloud repo can import.
 */
export const RECORD_OBJECT_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'role',
  'candidate',
] as const

export type RecordObjectType = (typeof RECORD_OBJECT_TYPES)[number]

/**
 * The record types a note, activity, decision, or plan item attaches to.
 *
 * Not the same list as `RECORD_OBJECT_TYPES`: a Role is a detail page a UI
 * module can extend, but nothing attaches a note to it. Interview notes go on
 * the Candidate, which is the person-and-role link.
 */
export const RECORD_TARGET_TYPES = [
  'person',
  'company',
  'deal',
  'opportunity',
  'partnership',
  'raise',
  'candidate',
] as const

export type RecordTargetType = (typeof RECORD_TARGET_TYPES)[number]

/**
 * What an activity says happened. `created`, `updated`, `stage_changed`,
 * `note_added`, `linked` and `unlinked` are emitted by the server; `email`,
 * `call` and `meeting` are logged history an integration or an agent supplies.
 *
 * `unlinked` is only filed when a link is deleted through its own route. A link
 * that dies with either of its ends never reaches a service, so the timeline
 * that survives keeps the `linked` row without a counterpart. That row is
 * history rather than a claim about the present, so it stays true either way.
 */
export const ACTIVITY_KINDS = [
  'created',
  'updated',
  'stage_changed',
  'note_added',
  'email',
  'call',
  'meeting',
  'linked',
  'unlinked',
] as const

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const

export type MemberRole = (typeof MEMBER_ROLES)[number]

/**
 * Fixed value sets shared by the wire schemas and by any UI that renders a
 * dropdown over one.
 *
 * These are a second copy of the arrays in `@kelpie/server`'s module schemas,
 * which is the price of a package the browser can import: pulling the server in
 * would bring Drizzle, postgres.js, and Node built-ins with it.
 *
 * The server's copy drives both its check constraints and its Zod enums, so a
 * value this package allows and the server does not comes back as a `422`
 * rather than as bad data. Nothing asserts the two lists are equal yet; that
 * needs the server to import this package, which is follow-up work.
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

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const

export type MemberRole = (typeof MEMBER_ROLES)[number]

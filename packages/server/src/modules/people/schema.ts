import { index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { checkOneOf, citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets from `seed.ts`. Exported because the API validates against
 * these same arrays: a value the boundary accepts and the check constraint
 * refuses would be a 500 where a 422 belongs.
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

/** Networks a person can be linked on, from `SOCIAL_NETWORKS` in the mockups. */
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

export interface SocialProfile {
  readonly network: SocialNetworkId
  readonly url: string
}

/**
 * Who you know. Job title is not here: it lives on Position, because a person can
 * hold titles at more than one company.
 *
 * `phones` and `social_profiles` are jsonb because nothing queries into them.
 * They are typed rather than left as `unknown`, and the route layer parses what
 * goes in, so a row read back is the shape it claims to be.
 */
export const people = pgTable(
  'people',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: citext('email'),
    phones: jsonb('phones').$type<readonly string[]>().notNull().default([]),
    socialProfiles: jsonb('social_profiles')
      .$type<readonly SocialProfile[]>()
      .notNull()
      .default([]),
    timezone: text('timezone'),
    location: text('location'),
    preferredChannel: text('preferred_channel').notNull(),
    influence: text('influence').notNull(),
    relationship: text('relationship').notNull(),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    lastContactedAt: moment('last_contacted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('people_workspace_email_key').on(table.workspaceId, table.email),
    index('people_workspace_idx').on(table.workspaceId),
    checkOneOf('people_preferred_channel_check', table.preferredChannel, PREFERRED_CHANNELS),
    checkOneOf('people_influence_check', table.influence, INFLUENCE_LEVELS),
    checkOneOf('people_relationship_check', table.relationship, RELATIONSHIP_LEVELS),
  ],
)

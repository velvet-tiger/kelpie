import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import { citext, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * Who you know. Job title is not here: it lives on Position, because a person can
 * hold titles at more than one company.
 *
 * `phones` and `social_profiles` are jsonb because nothing queries into them.
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
    phones: jsonb('phones').notNull().default([]),
    socialProfiles: jsonb('social_profiles').notNull().default([]),
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
    check(
      'people_preferred_channel_check',
      sql`${table.preferredChannel} in ('email', 'call', 'linkedin')`,
    ),
    check(
      'people_influence_check',
      sql`${table.influence} in ('champion', 'decision_maker', 'influencer', 'blocker', 'end_user')`,
    ),
    check('people_relationship_check', sql`${table.relationship} in ('cold', 'warm', 'strong')`),
  ],
)

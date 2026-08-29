import {
  INFLUENCE_LEVELS,
  PIPELINE_KINDS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
} from '@kelpie/schemas'
import type { SocialProfile } from '@kelpie/schemas'
import { index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core'

import {
  checkOneOf,
  citext,
  createdAt,
  moment,
  primaryId,
  searchVector,
  updatedAt,
} from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The fixed value sets come from `@kelpie/schemas`, so this table's check
 * constraints, this module's Zod enums, and the browser's decoder are one list
 * rather than three copies. A value the boundary accepts and the check
 * constraint refuses would be a 500 where a 422 belongs.
 *
 * Re-exported because `routes.ts` and `service.ts` read them from here, and the
 * table they constrain is the reason they matter.
 */
export {
  INFLUENCE_LEVELS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
  SOCIAL_NETWORK_IDS,
} from '@kelpie/schemas'
export type {
  Influence,
  PreferredChannel,
  Relationship,
  SocialNetworkId,
} from '@kelpie/schemas'
export type { SocialProfile }

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
    // Their title is not here because it is not on this table. `GET /v1/search`
    // reaches it through `positions.search_vector`.
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: people.name, weight: 'A' },
      { column: people.email, weight: 'B' },
      { column: people.summary, weight: 'B' },
      { column: people.tags, weight: 'C', array: true },
    ]),
  },
  (table) => [
    unique('people_workspace_email_key').on(table.workspaceId, table.email),
    index('people_workspace_idx').on(table.workspaceId),
    index('people_search_idx').using('gin', table.searchVector),
    checkOneOf('people_preferred_channel_check', table.preferredChannel, PREFERRED_CHANNELS),
    checkOneOf('people_influence_check', table.influence, INFLUENCE_LEVELS),
    checkOneOf('people_relationship_check', table.relationship, RELATIONSHIP_LEVELS),
  ],
)

/**
 * A person's involvement in a pipeline record — a deal, opportunity, raise, or
 * partnership. One polymorphic table instead of a join per pipeline type; the
 * person side keeps a real foreign key with **restrict**, so the database still
 * blocks deleting a person who is on a deal. The target side is polymorphic per
 * the convention: no FK, existence checked by the service, rows removed in the
 * target's own delete transaction (`attachedRecords.ts`).
 *
 * `company` and `role` are deliberately absent from the check constraint: a
 * link with a payload and its own lifecycle stays a typed object —
 * Person↔Company is **Position** (title), Person↔Role is **Candidate** (status,
 * stage, referrer).
 */
export const personLinks = pgTable(
  'person_links',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'restrict' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
  },
  (table) => [
    index('person_links_target_idx').on(table.workspaceId, table.targetType, table.targetId),
    unique('person_links_person_target_key').on(table.personId, table.targetType, table.targetId),
    checkOneOf('person_links_target_type_check', table.targetType, PIPELINE_KINDS),
  ],
)

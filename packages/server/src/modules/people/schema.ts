import {
  CONSENT_STATUSES,
  INFLUENCE_LEVELS,
  PIPELINE_KINDS,
  PREFERRED_CHANNELS,
  RELATIONSHIP_LEVELS,
} from '@kelpie/schemas'
import type { CustomFieldValue, SocialProfile } from '@kelpie/schemas'
import { boolean, index, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core'

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
import { consentPurposes } from '../consent-purposes/schema.ts'
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
    // The canonical display name is `name`, and it is the only one of these that
    // is required. The parts are recorded when they are known and left null when
    // they are not; nothing composes them back into `name` after the row exists,
    // so an edit to one never renames the record behind the editor's back.
    salutation: text('salutation'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    suffix: text('suffix'),
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
    // The Article 21 objection. A global do-not-contact signal, independent
    // of consent purposes: agents check this before outreach regardless of
    // per-purpose consent state. Never touched by forms or imports —
    // the workspace member owns this flag.
    doNotContact: boolean('do_not_contact').notNull().default(false),
    // Workspace-defined fields, keyed by definition key. The custom-fields
    // service validates every key on write; the store here just carries the
    // shape. Default `{}` mirrors `tags`'s default — the object is always
    // present, never null.
    customFields: jsonb('custom_fields')
      .$type<Readonly<Record<string, CustomFieldValue>>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Their title is not here because it is not on this table. `GET /v1/search`
    // reaches it through `positions.search_vector`.
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: people.name, weight: 'A' },
      // The parts carry the same weight as the display name: they exist so a
      // person can be found by a name they are not displayed under, and finding
      // them is the whole point of storing them. `salutation` and `suffix` are
      // left out — "Dr" and "Jr" match half a workspace and narrow nothing.
      { column: people.firstName, weight: 'A' },
      { column: people.lastName, weight: 'A' },
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
 * The explicit consent decision for one (person, purpose) pair.
 *
 * Absence of a row means "inherits the purpose's `default_status`", so no
 * `unknown` status here — a stored row always carries a decision. The pk is
 * composite on `(person_id, purpose_id)` with no public id; the row is
 * addressed by the pair, like `form_lists` and `form_attach_targets`.
 *
 * `source` records where the decision came from: `form:<form_id>`,
 * `list:<list_id>`, `import`, or `manual`. Cascade with both the person and
 * the purpose — erasing a person drops these with the rest of their record,
 * and removing a purpose drops every row that still names it.
 */
export const personConsents = pgTable(
  'person_consents',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    purposeId: text('purpose_id')
      .notNull()
      .references(() => consentPurposes.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    notedAt: moment('noted_at').notNull().defaultNow(),
    source: text('source').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.purposeId] }),
    index('person_consents_workspace_idx').on(table.workspaceId),
    index('person_consents_purpose_idx').on(table.purposeId),
    checkOneOf('person_consents_status_check', table.status, CONSENT_STATUSES),
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

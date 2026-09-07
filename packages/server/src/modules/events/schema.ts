import {
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUSES,
  EVENT_ASSOCIATION_TARGET_TYPES,
  EVENT_FORMATS,
  EVENT_STATUSES,
} from '@kelpie/schemas'
import type { CustomFieldValue } from '@kelpie/schemas'
import { index, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'

import {
  checkOneOf,
  createdAt,
  primaryId,
  searchVector,
  updatedAt,
} from '../../lib/columns.ts'
import type { SearchVectorPart } from '../../lib/columns.ts'
import { people } from '../people/schema.ts'
import { workspaceMembers, workspaces } from '../workspace/schema.ts'

export {
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUSES,
  EVENT_ASSOCIATION_TARGET_TYPES,
  EVENT_FORMATS,
  EVENT_STATUSES,
} from '@kelpie/schemas'
export type {
  AttendanceSource,
  AttendanceStatus,
  EventAssociationTargetType,
  EventFormat,
  EventStatus,
} from '@kelpie/schemas'

/**
 * A dated gathering. Not a pipeline: no stages, no kanban, no person_links.
 * People attach as Attendances; other records attach through event_associations.
 */
export const events = pgTable(
  'events',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull().default(''),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    timezone: text('timezone').notNull(),
    location: text('location').notNull().default(''),
    meetingUrl: text('meeting_url'),
    format: text('format').notNull(),
    details: text('details').notNull().default(''),
    status: text('status').notNull(),
    ownerId: text('owner_id').references(() => workspaceMembers.id, { onDelete: 'restrict' }),
    summary: text('summary').notNull().default(''),
    tags: text('tags').array().notNull().default([]),
    customFields: jsonb('custom_fields')
      .$type<Readonly<Record<string, CustomFieldValue>>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchVector: searchVector((): readonly SearchVectorPart[] => [
      { column: events.name, weight: 'A' },
      { column: events.details, weight: 'B' },
      { column: events.summary, weight: 'B' },
      { column: events.kind, weight: 'C' },
      { column: events.location, weight: 'C' },
      { column: events.tags, weight: 'C', array: true },
    ]),
  },
  (table) => [
    index('events_workspace_idx').on(table.workspaceId),
    index('events_starts_idx').on(table.workspaceId, table.startsAt),
    index('events_search_idx').using('gin', table.searchVector),
    checkOneOf('events_format_check', table.format, EVENT_FORMATS),
    checkOneOf('events_status_check', table.status, EVENT_STATUSES),
  ],
)

/** The Person↔Event link. RSVP state lives here, never on Person. */
export const attendances = pgTable(
  'attendances',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('attendances_event_person_key').on(table.eventId, table.personId),
    index('attendances_workspace_idx').on(table.workspaceId),
    index('attendances_event_idx').on(table.eventId),
    index('attendances_person_idx').on(table.personId),
    checkOneOf('attendances_status_check', table.status, ATTENDANCE_STATUSES),
    checkOneOf('attendances_source_check', table.source, ATTENDANCE_SOURCES),
  ],
)

/**
 * Event↔other record. Polymorphic target, no FK. The id never crosses the wire.
 */
export const eventAssociations = pgTable(
  'event_associations',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('event_associations_event_target_key').on(
      table.eventId,
      table.targetType,
      table.targetId,
    ),
    index('event_associations_target_idx').on(
      table.workspaceId,
      table.targetType,
      table.targetId,
    ),
    checkOneOf(
      'event_associations_target_type_check',
      table.targetType,
      EVENT_ASSOCIATION_TARGET_TYPES,
    ),
  ],
)

import { z } from 'zod'

import { customFieldValuesBody, customFieldValuesSchema } from './customField.ts'
import type { CustomFieldValue, CustomFieldValues } from './customField.ts'
import {
  EVENT_ASSOCIATION_TARGET_TYPES,
  EVENT_FORMATS,
  EVENT_STATUSES,
} from './values.ts'
import type {
  EventAssociationTargetType,
  EventFormat,
  EventStatus,
} from './values.ts'
import { definedFields, idSchema, recordTimestamps, timestampSchema } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/events`. */

export interface EventAssociation {
  readonly targetType: EventAssociationTargetType
  readonly targetId: string
}

export interface Event extends RecordTimestamps {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly timezone: string
  readonly location: string
  readonly meetingUrl: string | null
  readonly format: EventFormat
  readonly details: string
  readonly status: EventStatus
  readonly ownerId: string | null
  readonly summary: string
  readonly tags: readonly string[]
  readonly associations: readonly EventAssociation[]
  readonly customFields: CustomFieldValues
}

const associationSchema = z
  .object({
    target_type: z.enum(EVENT_ASSOCIATION_TARGET_TYPES),
    target_id: idSchema,
  })
  .transform(
    (wire): EventAssociation => ({
      targetType: wire.target_type,
      targetId: wire.target_id,
    }),
  )

export const eventSchema: z.ZodType<Event, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: z.string(),
    starts_at: timestampSchema,
    ends_at: timestampSchema,
    timezone: z.string(),
    location: z.string(),
    meeting_url: z.string().nullable(),
    format: z.enum(EVENT_FORMATS),
    details: z.string(),
    status: z.enum(EVENT_STATUSES),
    owner_id: idSchema.nullable(),
    summary: z.string(),
    tags: z.array(z.string()),
    associations: z.array(associationSchema),
    custom_fields: customFieldValuesSchema,
    ...recordTimestamps,
  })
  .transform(
    (wire): Event => ({
      id: wire.id,
      name: wire.name,
      kind: wire.kind,
      startsAt: wire.starts_at,
      endsAt: wire.ends_at,
      timezone: wire.timezone,
      location: wire.location,
      meetingUrl: wire.meeting_url,
      format: wire.format,
      details: wire.details,
      status: wire.status,
      ownerId: wire.owner_id,
      summary: wire.summary,
      tags: wire.tags,
      associations: wire.associations,
      customFields: wire.custom_fields,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

function associationBody(association: EventAssociation): Record<string, unknown> {
  return { target_type: association.targetType, target_id: association.targetId }
}

export interface EventInput {
  readonly name?: string
  readonly kind?: string
  readonly startsAt?: Date | string
  readonly endsAt?: Date | string
  readonly timezone?: string
  readonly location?: string
  readonly meetingUrl?: string | null
  readonly format?: EventFormat
  readonly details?: string
  readonly status?: EventStatus
  readonly ownerId?: string | null
  readonly summary?: string
  readonly tags?: readonly string[]
  readonly associations?: readonly EventAssociation[]
  readonly customFields?: Readonly<Record<string, CustomFieldValue | null>>
}

function timestampBody(value: Date | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  return value instanceof Date ? value.toISOString() : value
}

export function eventBody(input: EventInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    kind: input.kind,
    starts_at: timestampBody(input.startsAt),
    ends_at: timestampBody(input.endsAt),
    timezone: input.timezone,
    location: input.location,
    meeting_url: input.meetingUrl,
    format: input.format,
    details: input.details,
    status: input.status,
    owner_id: input.ownerId,
    summary: input.summary,
    tags: input.tags,
    associations: input.associations?.map(associationBody),
    custom_fields:
      input.customFields === undefined ? undefined : customFieldValuesBody(input.customFields),
  })
}

export interface CreateEventInput extends EventInput {
  readonly name: string
  readonly startsAt: Date | string
  readonly endsAt: Date | string
  readonly format: EventFormat
}

export function createEventBody(input: CreateEventInput): Record<string, unknown> {
  return eventBody(input)
}

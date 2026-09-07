import {
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUSES,
  EVENT_ASSOCIATION_TARGET_TYPES,
  EVENT_FORMATS,
  EVENT_STATUSES,
  customFieldsPatchShape,
} from '@kelpie/schemas'
import type { EventAssociationTargetType } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readIdFilter, readJsonBody, readListParameters } from '../../lib/http.ts'
import { renderCustomFieldsForWire } from '../custom-fields/wire.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type {
  AttendanceView,
  AttendancesService,
  CreateAttendanceInput,
  UpdateAttendanceInput,
} from './attendances.ts'
import type { CreateEventInput, EventView, EventsService, UpdateEventInput } from './service.ts'
import type { AssociationRef } from './repository.ts'

const isoTimestamp = z.iso.datetime()

const associationBody = z.strictObject({
  target_type: z.enum(EVENT_ASSOCIATION_TARGET_TYPES),
  target_id: z.string().min(1),
})

const eventShape = {
  name: z.string().min(1),
  kind: z.string(),
  starts_at: isoTimestamp,
  ends_at: isoTimestamp,
  timezone: z.string().min(1),
  location: z.string(),
  meeting_url: z.string().url().nullable(),
  format: z.enum(EVENT_FORMATS),
  details: z.string(),
  status: z.enum(EVENT_STATUSES),
  owner_id: z.string().min(1).nullable(),
  summary: z.string(),
  tags: z.array(z.string().min(1)),
  associations: z.array(associationBody),
  custom_fields: customFieldsPatchShape,
}

export const createEventBody = z.strictObject({
  ...eventShape,
  kind: eventShape.kind.default(''),
  timezone: eventShape.timezone.optional(),
  location: eventShape.location.default(''),
  meeting_url: eventShape.meeting_url.default(null),
  details: eventShape.details.default(''),
  status: eventShape.status.default('scheduled'),
  owner_id: eventShape.owner_id.optional(),
  summary: eventShape.summary.default(''),
  tags: eventShape.tags.default([]),
  associations: eventShape.associations.default([]),
  custom_fields: eventShape.custom_fields.default({}),
})

export const updateEventBody = z.strictObject(eventShape).partial()

const attendanceShape = {
  event_id: z.string().min(1),
  person_id: z.string().min(1),
  status: z.enum(ATTENDANCE_STATUSES),
  source: z.enum(ATTENDANCE_SOURCES),
}

export const createAttendanceBody = z.strictObject({
  ...attendanceShape,
  status: attendanceShape.status.default('registered'),
  source: attendanceShape.source.default('manual'),
})

export const nestedCreateAttendanceBody = z.strictObject({
  person_id: z.string().min(1),
  status: z.enum(ATTENDANCE_STATUSES).default('registered'),
})

export const updateAttendanceBody = z.strictObject({ status: z.enum(ATTENDANCE_STATUSES) }).partial()

export interface EventsRoutesDependencies extends CredentialDependencies {
  readonly events: EventsService
  readonly attendances: AttendancesService
}

function toAssociation(body: z.infer<typeof associationBody>): AssociationRef {
  return { targetType: body.target_type, targetId: body.target_id }
}

export function toCreateEventInput(body: z.infer<typeof createEventBody>): CreateEventInput {
  return {
    name: body.name,
    kind: body.kind,
    startsAt: new Date(body.starts_at),
    endsAt: new Date(body.ends_at),
    timezone: body.timezone,
    location: body.location,
    meetingUrl: body.meeting_url,
    format: body.format,
    details: body.details,
    status: body.status,
    ownerId: body.owner_id,
    summary: body.summary,
    tags: body.tags,
    associations: body.associations.map(toAssociation),
    customFields: body.custom_fields,
  }
}

export function toUpdateEventInput(body: z.infer<typeof updateEventBody>): UpdateEventInput {
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.kind === undefined ? {} : { kind: body.kind }),
    ...(body.starts_at === undefined ? {} : { startsAt: new Date(body.starts_at) }),
    ...(body.ends_at === undefined ? {} : { endsAt: new Date(body.ends_at) }),
    ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    ...(body.location === undefined ? {} : { location: body.location }),
    ...(body.meeting_url === undefined ? {} : { meetingUrl: body.meeting_url }),
    ...(body.format === undefined ? {} : { format: body.format }),
    ...(body.details === undefined ? {} : { details: body.details }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.owner_id === undefined ? {} : { ownerId: body.owner_id }),
    ...(body.summary === undefined ? {} : { summary: body.summary }),
    ...(body.tags === undefined ? {} : { tags: body.tags }),
    ...(body.associations === undefined
      ? {}
      : { associations: body.associations.map(toAssociation) }),
    ...(body.custom_fields === undefined ? {} : { customFields: body.custom_fields }),
  }
}

export function eventResponse(event: EventView): Record<string, unknown> {
  return {
    id: event.id,
    name: event.name,
    kind: event.kind,
    starts_at: event.startsAt.toISOString(),
    ends_at: event.endsAt.toISOString(),
    timezone: event.timezone,
    location: event.location,
    meeting_url: event.meetingUrl,
    format: event.format,
    details: event.details,
    status: event.status,
    owner_id: event.ownerId,
    summary: event.summary,
    tags: event.tags,
    associations: event.associations.map((row) => ({
      target_type: row.targetType,
      target_id: row.targetId,
    })),
    custom_fields: renderCustomFieldsForWire(event.customFields),
    created_at: event.createdAt.toISOString(),
    updated_at: event.updatedAt.toISOString(),
  }
}

export function toCreateAttendanceInput(
  body: z.infer<typeof createAttendanceBody>,
): CreateAttendanceInput {
  return {
    eventId: body.event_id,
    personId: body.person_id,
    status: body.status,
    source: body.source,
  }
}

export function toUpdateAttendanceInput(
  body: z.infer<typeof updateAttendanceBody>,
): UpdateAttendanceInput {
  return body.status === undefined ? {} : { status: body.status }
}

export function attendanceResponse(row: AttendanceView): Record<string, unknown> {
  return {
    id: row.id,
    event_id: row.eventId,
    person_id: row.personId,
    status: row.status,
    source: row.source,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function readEnumFilter<Value extends string>(
  context: Context,
  name: string,
  allowed: readonly Value[],
): readonly Value[] | undefined {
  const values = readIdFilter(context, name)

  if (values === undefined) {
    return undefined
  }

  const unknown = values.filter((value) => !allowed.includes(value as Value))

  if (unknown.length > 0) {
    throw AppError.validationFailed(`"${name}" does not take ${unknown.join(', ')}`, [
      { field: name, message: `Expected one of ${allowed.join(', ')}` },
    ])
  }

  return values as readonly Value[]
}

function readTimestampQuery(context: Context, name: string): Date | undefined {
  const raw = context.req.query(name)

  if (raw === undefined || raw === '') {
    return undefined
  }

  const parsed = isoTimestamp.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed(`"${name}" must be an ISO 8601 timestamp`, [
      { field: name, message: 'Use 2026-08-02T01:00:00.000Z' },
    ])
  }

  return new Date(parsed.data)
}

export function mountEventsRoutes(router: Hono, dependencies: EventsRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/events', async (context) => {
    const page = await dependencies.events.list(
      await requireActor(context),
      {
        term: context.req.query('q'),
        statuses: readEnumFilter(context, 'status', EVENT_STATUSES),
        formats: readEnumFilter(context, 'format', EVENT_FORMATS),
        ownerIds: readIdFilter(context, 'owner_id'),
        from: readTimestampQuery(context, 'from'),
        to: readTimestampQuery(context, 'to'),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, eventResponse))
  })

  router.post('/events', async (context) => {
    const body = await readJsonBody(context, createEventBody)
    const event = await dependencies.events.create(
      await requireActor(context),
      toCreateEventInput(body),
    )

    return context.json(eventResponse(event), 201)
  })

  router.get('/events/:id', async (context) => {
    const event = await dependencies.events.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(eventResponse(event))
  })

  router.patch('/events/:id', async (context) => {
    const body = await readJsonBody(context, updateEventBody)
    const event = await dependencies.events.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateEventInput(body),
    )

    return context.json(eventResponse(event))
  })

  router.delete('/events/:id', async (context) => {
    await dependencies.events.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.get('/events/:id/attendances', async (context) => {
    const page = await dependencies.attendances.list(
      await requireActor(context),
      {
        eventIds: [context.req.param('id')],
        statuses: readEnumFilter(context, 'status', ATTENDANCE_STATUSES),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, attendanceResponse))
  })

  router.post('/events/:id/attendances', async (context) => {
    const body = await readJsonBody(context, nestedCreateAttendanceBody)
    const row = await dependencies.attendances.create(await requireActor(context), {
      eventId: context.req.param('id'),
      personId: body.person_id,
      status: body.status,
      source: 'manual',
    })

    return context.json(attendanceResponse(row), 201)
  })

  router.get('/attendances', async (context) => {
    const page = await dependencies.attendances.list(
      await requireActor(context),
      {
        eventIds: readIdFilter(context, 'event_id'),
        personIds: readIdFilter(context, 'person_id'),
        statuses: readEnumFilter(context, 'status', ATTENDANCE_STATUSES),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, attendanceResponse))
  })

  router.post('/attendances', async (context) => {
    const body = await readJsonBody(context, createAttendanceBody)
    const row = await dependencies.attendances.create(
      await requireActor(context),
      toCreateAttendanceInput(body),
    )

    return context.json(attendanceResponse(row), 201)
  })

  router.get('/attendances/:id', async (context) => {
    const row = await dependencies.attendances.get(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(attendanceResponse(row))
  })

  router.patch('/attendances/:id', async (context) => {
    const body = await readJsonBody(context, updateAttendanceBody)
    const row = await dependencies.attendances.update(
      await requireActor(context),
      context.req.param('id'),
      toUpdateAttendanceInput(body),
    )

    return context.json(attendanceResponse(row))
  })

  router.delete('/attendances/:id', async (context) => {
    await dependencies.attendances.remove(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.get('/event-associations', async (context) => {
    const actor = await requireActor(context)
    const targetType = context.req.query('target_type')
    const targetId = context.req.query('target_id')

    if (targetType === undefined || targetId === undefined || targetId === '') {
      throw AppError.validationFailed('target_type and target_id are required', [
        { field: 'target_type', message: 'Required with target_id' },
      ])
    }

    const parsed = z.enum(EVENT_ASSOCIATION_TARGET_TYPES).safeParse(targetType)

    if (!parsed.success) {
      throw AppError.validationFailed('Unknown association target type', [
        {
          field: 'target_type',
          message: `Use one of: ${EVENT_ASSOCIATION_TARGET_TYPES.join(', ')}`,
        },
      ])
    }

    const rows = await dependencies.events.listAssociationsFor(
      actor,
      parsed.data as EventAssociationTargetType,
      targetId,
    )

    return context.json({
      data: rows.map((row) => ({
        event_id: row.eventId,
        event_name: row.eventName,
        target_type: parsed.data,
        target_id: targetId,
      })),
      next_cursor: null,
    })
  })
}

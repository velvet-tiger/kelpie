import { z } from 'zod'

import { ATTENDANCE_SOURCES, ATTENDANCE_STATUSES } from './values.ts'
import type { AttendanceSource, AttendanceStatus } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/attendances`, the Person↔Event link.
 *
 * RSVP state sits here rather than on Person, so the same person can attend one
 * webinar and cancel another. Notes attach to the attendance, not to the person
 * or the event in general.
 *
 * Neither end is updatable: moving an attendance to a different event or person
 * is a delete and a create, the rule Candidate already follows.
 */

export interface Attendance extends RecordTimestamps {
  readonly id: string
  readonly eventId: string
  readonly personId: string
  readonly status: AttendanceStatus
  readonly source: AttendanceSource
}

export const attendanceSchema: z.ZodType<Attendance, unknown> = z
  .object({
    id: idSchema,
    event_id: idSchema,
    person_id: idSchema,
    status: z.enum(ATTENDANCE_STATUSES),
    source: z.enum(ATTENDANCE_SOURCES),
    ...recordTimestamps,
  })
  .transform(
    (wire): Attendance => ({
      id: wire.id,
      eventId: wire.event_id,
      personId: wire.person_id,
      status: wire.status,
      source: wire.source,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateAttendanceInput {
  readonly eventId: string
  readonly personId: string
  readonly status?: AttendanceStatus
  readonly source?: AttendanceSource
}

export function createAttendanceBody(input: CreateAttendanceInput): Record<string, unknown> {
  return definedFields({
    event_id: input.eventId,
    person_id: input.personId,
    status: input.status,
    source: input.source,
  })
}

export interface AttendanceInput {
  readonly status?: AttendanceStatus
}

export function attendanceBody(input: AttendanceInput): Record<string, unknown> {
  return definedFields({
    status: input.status,
  })
}

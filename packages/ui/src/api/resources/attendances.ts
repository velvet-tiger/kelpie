import { attendanceBody, attendanceSchema, createAttendanceBody } from '@kelpie/schemas'
import type { Attendance, AttendanceInput, AttendanceStatus, CreateAttendanceInput } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type { ListOptions, MutationResult, RecordListResult, UpdateArguments } from '../resource.ts'

/**
 * `/v1/attendances`, the Person↔Event link.
 */

const attendances = createResourceHooks<Attendance, CreateAttendanceInput, AttendanceInput>({
  name: 'attendances',
  path: '/attendances',
  decode: attendanceSchema.parse,
  createBody: createAttendanceBody,
  updateBody: attendanceBody,
  alsoInvalidates: ['activities', 'notes', 'events', 'people', 'dashboard'],
})

export interface AttendanceFilters {
  readonly eventIds?: readonly string[] | undefined
  readonly personIds?: readonly string[] | undefined
  readonly statuses?: readonly AttendanceStatus[] | undefined
  readonly limit?: number | undefined
}

function attendanceQuery(filters: AttendanceFilters): QueryParameters {
  return {
    event_id: filters.eventIds,
    person_id: filters.personIds,
    status: filters.statuses,
    limit: filters.limit,
  }
}

export function useAttendances(
  filters: AttendanceFilters = {},
  options: ListOptions = {},
): RecordListResult<Attendance> {
  return attendances.useList(attendanceQuery(filters), options)
}

export function useCreateAttendance(): MutationResult<CreateAttendanceInput, Attendance> {
  return attendances.useCreate()
}

export function useUpdateAttendance(): MutationResult<UpdateArguments<AttendanceInput>, Attendance> {
  return attendances.useUpdate()
}

export function useDeleteAttendance(): MutationResult<string, void> {
  return attendances.useRemove()
}

import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import {
  enumSetArg,
  idArg,
  idSetArg,
  listWindowShape,
  registerCrudTools,
  termArg,
  toSet,
} from '../crudTools.ts'
import { ATTENDANCE_STATUSES, EVENT_ASSOCIATION_TARGET_TYPES, EVENT_FORMATS, EVENT_STATUSES } from './schema.ts'
import type { AttendancesService } from './attendances.ts'
import type { EventsService } from './service.ts'
import {
  attendanceResponse,
  createAttendanceBody,
  createEventBody,
  eventResponse,
  toCreateAttendanceInput,
  toCreateEventInput,
  toUpdateAttendanceInput,
  toUpdateEventInput,
  updateAttendanceBody,
  updateEventBody,
} from './routes.ts'

const eventListArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  status: enumSetArg(EVENT_STATUSES).optional().describe('draft, scheduled, cancelled.'),
  format: enumSetArg(EVENT_FORMATS).optional().describe('in_person, virtual, hybrid.'),
  owner_id: idSetArg.optional().describe('Events owned by these members.'),
  from: z.iso.datetime().optional().describe('Only events whose start is on or after this instant.'),
  to: z.iso.datetime().optional().describe('Only events whose start is on or before this instant.'),
})

const attendanceListArgs = z.strictObject({
  ...listWindowShape,
  event_id: idSetArg.optional().describe('Attendances on these events.'),
  person_id: idSetArg.optional().describe('Attendances for these people.'),
  status: enumSetArg(ATTENDANCE_STATUSES).optional(),
})

export function registerEventsTools(
  mcp: McpToolRegistry,
  services: { readonly events: EventsService; readonly attendances: AttendancesService },
): void {
  registerCrudTools(mcp, {
    resource: 'events',
    subject: 'event',
    about:
      'A dated gathering (webinar, meetup, dinner). Not a pipeline. People attach as attendances.',
    service: services.events,
    render: eventResponse,
    listArgs: eventListArgs,
    toFilters: (args) => ({
      term: args.q,
      statuses: toSet(args.status),
      formats: toSet(args.format),
      ownerIds: toSet(args.owner_id),
      from: args.from === undefined ? undefined : new Date(args.from),
      to: args.to === undefined ? undefined : new Date(args.to),
    }),
    createArgs: createEventBody,
    toCreateInput: toCreateEventInput,
    updateArgs: updateEventBody.extend({ id: idArg }),
    toUpdateInput: toUpdateEventInput,
  })

  registerCrudTools(mcp, {
    resource: 'attendances',
    subject: 'attendance',
    about:
      "One person's registration for one event: registered, attended, no_show, or cancelled.",
    service: services.attendances,
    render: attendanceResponse,
    listArgs: attendanceListArgs,
    toFilters: (args) => ({
      eventIds: toSet(args.event_id),
      personIds: toSet(args.person_id),
      statuses: toSet(args.status),
    }),
    createArgs: createAttendanceBody,
    toCreateInput: toCreateAttendanceInput,
    updateArgs: updateAttendanceBody.extend({ id: idArg }),
    toUpdateInput: toUpdateAttendanceInput,
  })

  mcp.tool({
    name: 'event_associations_list',
    description:
      'Events associated with another record (a Deal, Company, Role, …). ' +
      'Mirrors GET /v1/event-associations.',
    inputSchema: z.strictObject({
      target_type: z.enum(EVENT_ASSOCIATION_TARGET_TYPES),
      target_id: idArg,
    }),
    invoke: async (args, actor) => {
      const rows = await services.events.listAssociationsFor(
        actor,
        args.target_type,
        args.target_id,
      )

      return {
        data: rows.map((row) => ({
          event_id: row.eventId,
          event_name: row.eventName,
          target_type: args.target_type,
          target_id: args.target_id,
        })),
        next_cursor: null,
      }
    },
  })
}

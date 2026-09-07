import { createEventBody, eventBody, eventSchema } from '@kelpie/schemas'
import type { CreateEventInput, Event as CrmEvent, EventFormat, EventInput, EventStatus } from '@kelpie/schemas'

import type { QueryParameters } from '../client.ts'
import { createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'

/**
 * `/v1/events`. A dated gathering, not a pipeline: no stages and no kanban.
 */

const events = createResourceHooks<CrmEvent, CreateEventInput, EventInput>({
  name: 'events',
  path: '/events',
  decode: eventSchema.parse,
  createBody: createEventBody,
  updateBody: eventBody,
  alsoInvalidates: ['activities', 'attendances', 'eventAssociations', 'dashboard'],
})

export interface EventFilters {
  readonly term?: string | undefined
  readonly statuses?: readonly EventStatus[] | undefined
  readonly formats?: readonly EventFormat[] | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly limit?: number | undefined
  readonly sort?: string | undefined
}

function eventQuery(filters: EventFilters): QueryParameters {
  return {
    q: filters.term,
    status: filters.statuses,
    format: filters.formats,
    from: filters.from,
    to: filters.to,
    limit: filters.limit,
    sort: filters.sort,
  }
}

export function useEvents(
  filters: EventFilters = {},
  options: ListOptions = {},
): RecordListResult<CrmEvent> {
  return events.useList(eventQuery(filters), options)
}

export function useEvent(id: string | undefined): RecordResult<CrmEvent> {
  return events.useRecord(id)
}

export function useCreateEvent(): MutationResult<CreateEventInput, CrmEvent> {
  return events.useCreate()
}

export function useUpdateEvent(): MutationResult<UpdateArguments<EventInput>, CrmEvent> {
  return events.useUpdate()
}

export function useDeleteEvent(): MutationResult<string, void> {
  return events.useRemove()
}

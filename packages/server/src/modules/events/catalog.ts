import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the events module (CRM gatherings + attendances). */

export const crmEventsCatalog = {
  'events.event.created': z.object({}).strict(),
  'events.event.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'events.event.deleted': z.object({}).strict(),
  'events.attendance.created': z.object({}).strict(),
  'events.attendance.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'events.attendance.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type CrmEventCreatedData = Record<string, never>
export interface CrmEventUpdatedData {
  readonly changed: readonly string[]
}
export type CrmEventDeletedData = Record<string, never>
export type AttendanceCreatedData = Record<string, never>
export interface AttendanceUpdatedData {
  readonly changed: readonly string[]
}
export type AttendanceDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'events.event.created': CrmEventCreatedData
    'events.event.updated': CrmEventUpdatedData
    'events.event.deleted': CrmEventDeletedData
    'events.attendance.created': AttendanceCreatedData
    'events.attendance.updated': AttendanceUpdatedData
    'events.attendance.deleted': AttendanceDeletedData
  }
}

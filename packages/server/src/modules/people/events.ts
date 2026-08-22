import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the people module.
 *
 * The runtime catalog (below) is the authority; the `KelpieEventMap`
 * augmentation gives autocomplete at every emit and subscribe site.
 */

export const PEOPLE_EVENT_NAMES = [
  'people.person.created',
  'people.person.updated',
  'people.person.deleted',
] as const

export const peopleEvents = {
  'people.person.created': z.object({}).strict(),
  'people.person.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'people.person.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type PersonCreatedData = Record<string, never>
export interface PersonUpdatedData {
  readonly changed: readonly string[]
}
export type PersonDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'people.person.created': PersonCreatedData
    'people.person.updated': PersonUpdatedData
    'people.person.deleted': PersonDeletedData
  }
}

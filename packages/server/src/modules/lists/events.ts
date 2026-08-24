import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the lists module.
 *
 * `target` on a `lists.list.*` event is the list itself. `lists.member.*` events
 * name the record that changed membership, so a consumer watching records hears
 * about a list touching it without a second lookup.
 */

export const listsEvents = {
  'lists.list.created': z.object({}).strict(),
  'lists.list.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'lists.list.deleted': z.object({}).strict(),
  'lists.member.added': z.object({ listId: z.string() }),
  'lists.member.removed': z.object({ listId: z.string() }),
} satisfies ModuleEventCatalog

export type ListCreatedData = Record<string, never>
export interface ListUpdatedData {
  readonly changed: readonly string[]
}
export type ListDeletedData = Record<string, never>
export interface ListMemberAddedData {
  readonly listId: string
}
export interface ListMemberRemovedData {
  readonly listId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'lists.list.created': ListCreatedData
    'lists.list.updated': ListUpdatedData
    'lists.list.deleted': ListDeletedData
    'lists.member.added': ListMemberAddedData
    'lists.member.removed': ListMemberRemovedData
  }
}

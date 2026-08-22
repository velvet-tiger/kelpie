import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the handbook module.
 *
 * Handbook pages are content objects, not CRM records — the target type is
 * `handbook_page`, and the webhooks bridge does not (yet) deliver these to
 * subscribers. They still fire on the bus for in-process consumers.
 */

export const handbookEvents = {
  'handbook.page.created': z.object({}).strict(),
  'handbook.page.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'handbook.page.deleted': z.object({}).strict(),
} satisfies ModuleEventCatalog

export type HandbookPageCreatedData = Record<string, never>
export interface HandbookPageUpdatedData {
  readonly changed: readonly string[]
}
export type HandbookPageDeletedData = Record<string, never>

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'handbook.page.created': HandbookPageCreatedData
    'handbook.page.updated': HandbookPageUpdatedData
    'handbook.page.deleted': HandbookPageDeletedData
  }
}

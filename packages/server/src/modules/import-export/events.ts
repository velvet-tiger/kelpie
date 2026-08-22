import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the import-export module.
 *
 * Record events (`people.person.created`, etc.) fire from this module during
 * an import, but they are owned by the record's module and declared in its
 * catalog. `imports.job.completed` is what this module owns.
 */

export const importExportEvents = {
  'imports.job.completed': z.object({ object: z.string() }),
} satisfies ModuleEventCatalog

export interface ImportCompletedData {
  readonly object: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'imports.job.completed': ImportCompletedData
  }
}

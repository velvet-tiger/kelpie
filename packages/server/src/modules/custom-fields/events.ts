import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the custom-fields module.
 *
 * `target` is the definition. The value-side changes ride each object module's
 * own `.updated` event, with per-key entries in `changed` shaped as
 * `customFields.<key>`. The webhooks bridge does not translate any of these —
 * `custom_fields.field` is not in `RECORD_OBJECT_TYPES`, and there is no
 * `record.*` wire event for a definition CRUD, so the four-event wire catalog
 * stays unchanged.
 */

export const customFieldsEvents = {
  'custom_fields.field.created': z.object({ objectType: z.string(), key: z.string() }),
  'custom_fields.field.updated': z.object({
    objectType: z.string(),
    key: z.string(),
    changed: z.array(z.string()).readonly(),
  }),
  'custom_fields.field.deleted': z.object({
    objectType: z.string(),
    key: z.string(),
    strippedRecordCount: z.number().int(),
  }),
} satisfies ModuleEventCatalog

export interface CustomFieldCreatedData {
  readonly objectType: string
  readonly key: string
}
export interface CustomFieldUpdatedData {
  readonly objectType: string
  readonly key: string
  readonly changed: readonly string[]
}
export interface CustomFieldDeletedData {
  readonly objectType: string
  readonly key: string
  readonly strippedRecordCount: number
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'custom_fields.field.created': CustomFieldCreatedData
    'custom_fields.field.updated': CustomFieldUpdatedData
    'custom_fields.field.deleted': CustomFieldDeletedData
  }
}

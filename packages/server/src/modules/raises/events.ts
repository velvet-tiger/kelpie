import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the raises module. */

export const raisesEvents = {
  'raises.raise.created': z.object({}).strict(),
  'raises.raise.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'raises.raise.deleted': z.object({}).strict(),
  'raises.raise.stage_changed': z.object({
    fromStageId: z.string().nullable(),
    toStageId: z.string(),
  }),
  'raises.raise.converted': z.object({
    targetType: z.string(),
    targetId: z.string(),
  }),
} satisfies ModuleEventCatalog

export type RaiseCreatedData = Record<string, never>
export interface RaiseUpdatedData {
  readonly changed: readonly string[]
}
export type RaiseDeletedData = Record<string, never>
export interface RaiseStageChangedData {
  readonly fromStageId: string | null
  readonly toStageId: string
}
export interface RaiseConvertedData {
  readonly targetType: string
  readonly targetId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'raises.raise.created': RaiseCreatedData
    'raises.raise.updated': RaiseUpdatedData
    'raises.raise.deleted': RaiseDeletedData
    'raises.raise.stage_changed': RaiseStageChangedData
    'raises.raise.converted': RaiseConvertedData
  }
}

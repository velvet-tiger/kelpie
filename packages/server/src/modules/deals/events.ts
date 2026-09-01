import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the deals module. */

export const dealsEvents = {
  'deals.deal.created': z.object({}).strict(),
  'deals.deal.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'deals.deal.deleted': z.object({}).strict(),
  'deals.deal.stage_changed': z.object({
    fromStageId: z.string().nullable(),
    toStageId: z.string(),
  }),
  'deals.deal.converted': z.object({
    targetType: z.string(),
    targetId: z.string(),
  }),
} satisfies ModuleEventCatalog

export type DealCreatedData = Record<string, never>
export interface DealUpdatedData {
  readonly changed: readonly string[]
}
export type DealDeletedData = Record<string, never>
export interface DealStageChangedData {
  readonly fromStageId: string | null
  readonly toStageId: string
}
export interface DealConvertedData {
  readonly targetType: string
  readonly targetId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'deals.deal.created': DealCreatedData
    'deals.deal.updated': DealUpdatedData
    'deals.deal.deleted': DealDeletedData
    'deals.deal.stage_changed': DealStageChangedData
    'deals.deal.converted': DealConvertedData
  }
}

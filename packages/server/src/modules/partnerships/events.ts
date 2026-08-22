import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the partnerships module. */

export const partnershipsEvents = {
  'partnerships.partnership.created': z.object({}).strict(),
  'partnerships.partnership.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'partnerships.partnership.deleted': z.object({}).strict(),
  'partnerships.partnership.stage_changed': z.object({
    fromStageId: z.string().nullable(),
    toStageId: z.string(),
  }),
} satisfies ModuleEventCatalog

export type PartnershipCreatedData = Record<string, never>
export interface PartnershipUpdatedData {
  readonly changed: readonly string[]
}
export type PartnershipDeletedData = Record<string, never>
export interface PartnershipStageChangedData {
  readonly fromStageId: string | null
  readonly toStageId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'partnerships.partnership.created': PartnershipCreatedData
    'partnerships.partnership.updated': PartnershipUpdatedData
    'partnerships.partnership.deleted': PartnershipDeletedData
    'partnerships.partnership.stage_changed': PartnershipStageChangedData
  }
}

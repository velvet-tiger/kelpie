import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/** Domain events published by the opportunities module. */

export const opportunitiesEvents = {
  'opportunities.opportunity.created': z.object({}).strict(),
  'opportunities.opportunity.updated': z.object({ changed: z.array(z.string()).readonly() }),
  'opportunities.opportunity.deleted': z.object({}).strict(),
  'opportunities.opportunity.stage_changed': z.object({
    fromStageId: z.string().nullable(),
    toStageId: z.string(),
  }),
  'opportunities.opportunity.converted': z.object({
    targetType: z.string(),
    targetId: z.string(),
  }),
} satisfies ModuleEventCatalog

export type OpportunityCreatedData = Record<string, never>
export interface OpportunityUpdatedData {
  readonly changed: readonly string[]
}
export type OpportunityDeletedData = Record<string, never>
export interface OpportunityStageChangedData {
  readonly fromStageId: string | null
  readonly toStageId: string
}
export interface OpportunityConvertedData {
  readonly targetType: string
  readonly targetId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'opportunities.opportunity.created': OpportunityCreatedData
    'opportunities.opportunity.updated': OpportunityUpdatedData
    'opportunities.opportunity.deleted': OpportunityDeletedData
    'opportunities.opportunity.stage_changed': OpportunityStageChangedData
    'opportunities.opportunity.converted': OpportunityConvertedData
  }
}

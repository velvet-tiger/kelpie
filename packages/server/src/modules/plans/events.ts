import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the plans module.
 *
 * `target` is the record the plan item attaches to; the plan item's own id
 * lives in `data`.
 */

export const plansEvents = {
  'plans.plan_item.completed': z.object({ planItemId: z.string() }),
} satisfies ModuleEventCatalog

export interface PlanItemCompletedData {
  readonly planItemId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'plans.plan_item.completed': PlanItemCompletedData
  }
}

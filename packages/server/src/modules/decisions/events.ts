import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the decisions module.
 *
 * `target` is the record the decision attaches to; the decision's own id lives
 * in `data`.
 */

export const decisionsEvents = {
  'decisions.decision.added': z.object({ decisionId: z.string() }),
} satisfies ModuleEventCatalog

export interface DecisionAddedData {
  readonly decisionId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'decisions.decision.added': DecisionAddedData
  }
}

import { WRITE_ORIGINS } from '@kelpie/schemas'
import type { WriteOrigin } from '@kelpie/schemas'
import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the decisions module.
 *
 * `target` is the record the decision attaches to; the decision's own id lives
 * in `data`.
 *
 * `decision.added` fires for a proposal too, so it says which it is. A
 * subscriber that posts "we decided" somewhere must read `confirmed`: a
 * decision from a hosted AI run, or from an agent without `decisions:commit`,
 * is added with `confirmed: false`, and is a commitment only after
 * `decision.confirmed` fires for it. A decision that is confirmed as it is
 * written gets `decision.added` alone.
 *
 * `decision.unconfirmed` fires when a commitment goes back to a proposal: a
 * caller that cannot commit rewrote its text. `decision.confirmed` fires again
 * if a member then confirms the new text. No other edit has an event.
 */

export const decisionsEvents = {
  'decisions.decision.added': z.object({
    decisionId: z.string(),
    origin: z.enum(WRITE_ORIGINS),
    confirmed: z.boolean(),
  }),
  'decisions.decision.confirmed': z.object({ decisionId: z.string(), origin: z.enum(WRITE_ORIGINS) }),
  'decisions.decision.unconfirmed': z.object({ decisionId: z.string(), origin: z.enum(WRITE_ORIGINS) }),
} satisfies ModuleEventCatalog

export interface DecisionAddedData {
  readonly decisionId: string
  readonly origin: WriteOrigin
  readonly confirmed: boolean
}

export interface DecisionConfirmedData {
  readonly decisionId: string
  readonly origin: WriteOrigin
}

export interface DecisionUnconfirmedData {
  readonly decisionId: string
  /** The origin after the edit that took the confirmation off. */
  readonly origin: WriteOrigin
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'decisions.decision.added': DecisionAddedData
    'decisions.decision.confirmed': DecisionConfirmedData
    'decisions.decision.unconfirmed': DecisionUnconfirmedData
  }
}

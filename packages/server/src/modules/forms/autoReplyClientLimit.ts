import type { IdFactory } from '../../lib/ids.ts'
import type { Transaction } from '../../runtime/transaction.ts'
import {
  FORM_AUTO_REPLY_CLIENT_SCOPE,
  incrementRateLimitBucket,
  pruneRateLimitScope,
} from '../rate-limit/repository.ts'
import { startOfUtcDay } from './emailMessages.ts'

/**
 * The daily limit on auto-replies one client address can cause.
 *
 * A workspace sends a limited number of auto-replies in a day
 * (`FORMS_AUTO_REPLY_DAILY_LIMIT`). Without this, one source could use that
 * number up with accepted submits, each naming a different address, and the
 * real visitors of that day would get no reply.
 *
 * The count is a rate-limit bucket for the UTC day, keyed by the workspace and
 * the key the limiter already counts this caller under (an IPv6 client by its
 * `/64`). Nothing about the client is stored on the submission.
 */

/** The reason the email job records when it sends no auto-reply for this limit. */
export const AUTO_REPLY_CLIENT_LIMIT_DETAIL = 'Daily auto-reply limit for one client address reached'

/**
 * The key for a submit whose client address is not known: the service is
 * assembled without the limiter in front of the public routes. All such
 * submits share one count, which limits too much, not too little.
 */
export const UNKNOWN_CLIENT_KEY = 'unknown'

export interface AutoReplyClientLimitDependencies {
  readonly createId: IdFactory
  readonly now: () => Date
  /** `FORMS_AUTO_REPLY_CLIENT_DAILY_LIMIT`. */
  readonly limit: number
}

/**
 * Counts one auto-reply this client is about to cause in this workspace today.
 *
 * Runs on the submit's transaction, so a submit that rolls back is not
 * counted. A submit over the limit is counted too: that costs nothing, and it
 * keeps this one atomic upsert with no read before it to race against.
 *
 * @returns False when this submit is over the limit and must send no auto-reply.
 */
export async function spendClientAutoReply(
  tx: Transaction,
  dependencies: AutoReplyClientLimitDependencies,
  workspaceId: string,
  clientKey: string,
): Promise<boolean> {
  const today = startOfUtcDay(dependencies.now())
  const count = await incrementRateLimitBucket(tx, {
    id: dependencies.createId('rateLimitBucket'),
    scope: FORM_AUTO_REPLY_CLIENT_SCOPE,
    key: `${workspaceId}:${clientKey}`,
    windowStart: today,
  })

  // A client's first count of a day sweeps the earlier days, so the table
  // holds about one day of these keys and no more.
  if (count === 1) {
    await pruneRateLimitScope(tx, FORM_AUTO_REPLY_CLIENT_SCOPE, today)
  }

  return count <= dependencies.limit
}

import type { Database } from '../../lib/database.ts'
import { describeThrown } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { WebhookEventPayload } from './payloads.ts'
import * as repository from './repository.ts'
import type { WebhookRecord } from './repository.ts'
import { deliveryBody, deliveryHeaders, renderDeliveryBody, signDeliveryBody } from './signing.ts'
import type { DeliveryEnvelope } from './signing.ts'

/**
 * The delivery engine: a consumer of the internal event bus that turns one
 * domain event into one signed HTTP request per subscribed webhook.
 *
 * It runs after the emitting transaction commits and is not awaited by the
 * request that caused it (`runtime/transaction.ts`), so an unreachable endpoint
 * slows nobody down.
 *
 * Delivery is at-least-once and there is no durable queue, the same caveat the
 * bus itself carries. A crash between the commit and the last attempt loses the
 * delivery; the retry budget below is deliberately small so a graceful shutdown
 * is not held open for minutes waiting for an endpoint that is already gone.
 */

/** How long one attempt may take before it counts as failed. */
export const DELIVERY_TIMEOUT_MS = 10_000

/** Waits between attempts. Its length plus one is the attempt budget. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000]

export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1

/**
 * @param attempts How many attempts have already been made.
 * @returns How long to wait before the next one, or undefined when the budget
 *   is spent and the delivery has failed for good.
 */
export function retryDelayAfter(attempts: number): number | undefined {
  return RETRY_DELAYS_MS[attempts - 1]
}

export interface DeliveryRequest {
  readonly url: string
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

export interface AttemptOutcome {
  readonly delivered: boolean
  /** The response status, or null when no response arrived at all. */
  readonly status: number | null
  /** Why it failed, for the log. Null on success. */
  readonly reason: string | null
}

/** The outbound port. Injected so no test makes a network call. */
export type SendDelivery = (request: DeliveryRequest) => Promise<AttemptOutcome>

export type Sleep = (milliseconds: number) => Promise<void>

export function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

/**
 * The real sender.
 *
 * Redirects are not followed. A customer whose endpoint moved should see the
 * `301` and update the registration, rather than have Kelpie quietly post
 * workspace data to whichever host the old one now points at.
 *
 * The catch is broad because this is the process boundary: `fetch` rejects with
 * anything from a DNS failure to an abort, the set is open, and turning all of
 * it into one outcome is the port's whole job. Nothing is swallowed — the
 * reason reaches the log and the delivery is recorded as failed.
 */
export function createHttpSender(fetchImplementation: typeof fetch = fetch): SendDelivery {
  return async (request) => {
    try {
      const response = await fetchImplementation(request.url, {
        method: 'POST',
        body: request.body,
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      })

      return response.ok
        ? { delivered: true, status: response.status, reason: null }
        : {
            delivered: false,
            status: response.status,
            reason: `endpoint answered ${String(response.status)}`,
          }
    } catch (error: unknown) {
      return { delivered: false, status: null, reason: describeThrown(error) }
    }
  }
}

export interface DeliveryDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly cipher: SecretCipher
  readonly send: SendDelivery
  /** Injected so tests do not spend the retry budget in real time. */
  readonly sleep: Sleep
  readonly log: Logger
}

export interface DeliveryEngine {
  /** Fans one event out to every subscribed webhook in its workspace. */
  deliver(payload: WebhookEventPayload): Promise<void>
}

export function createDeliveryEngine(dependencies: DeliveryDependencies): DeliveryEngine {
  /**
   * Writes the outcome: one log row, and the webhook's status when it moved.
   *
   * One transaction, so a reader never sees a hook marked failing with no
   * failure recorded against it.
   */
  function record(
    webhook: WebhookRecord,
    payload: WebhookEventPayload,
    delivery: {
      id: string
      sentAt: Date
      body: Record<string, unknown>
      attempts: number
      outcome: AttemptOutcome
    },
  ): Promise<void> {
    const nextStatus = delivery.outcome.delivered ? 'active' : 'failing'

    return dependencies.transaction(async ({ tx }) => {
      await repository.insertDelivery(tx, {
        id: delivery.id,
        workspaceId: webhook.workspaceId,
        webhookId: webhook.id,
        event: payload.event,
        payload: delivery.body,
        status: delivery.outcome.delivered ? 'success' : 'failed',
        attempts: delivery.attempts,
        // `created_at` is when the delivery was built, which is the `created_at`
        // inside the payload too, so the log row and what the receiver holds
        // agree. `delivered_at` is when it actually landed, up to the whole
        // retry budget later.
        deliveredAt: delivery.outcome.delivered ? dependencies.now() : null,
        createdAt: delivery.sentAt,
      })

      // A paused webhook is never selected for delivery, so the only statuses
      // reachable here are the two the engine owns. Leaving an unchanged one
      // alone keeps a healthy endpoint from being rewritten on every event.
      if (webhook.status !== nextStatus) {
        await repository.setWebhookStatus(tx, webhook.id, nextStatus)
      }
    })
  }

  async function attemptUntilDelivered(request: DeliveryRequest): Promise<{
    attempts: number
    outcome: AttemptOutcome
  }> {
    let attempts = 0

    for (;;) {
      attempts += 1

      const outcome = await dependencies.send(request)

      if (outcome.delivered) {
        return { attempts, outcome }
      }

      const delay = retryDelayAfter(attempts)

      if (delay === undefined) {
        return { attempts, outcome }
      }

      await dependencies.sleep(delay)
    }
  }

  async function deliverTo(webhook: WebhookRecord, payload: WebhookEventPayload): Promise<void> {
    const deliveryId = dependencies.createId('webhookDelivery')
    const envelope: DeliveryEnvelope = {
      deliveryId,
      event: payload.event,
      sentAt: dependencies.now(),
      workspaceId: payload.workspaceId,
      data: payload.data,
    }
    const body = deliveryBody(envelope)
    const text = renderDeliveryBody(body)
    // A secret that will not decrypt throws, and the caller logs it against
    // this webhook. Deliberately not recorded as a failed delivery: the
    // endpoint did nothing wrong, Kelpie's key did, and marking the
    // registration `failing` would send the customer debugging their own
    // server while the real fault is `SECRET_ENCRYPTION_KEY`.
    const secret = dependencies.cipher.open(webhook.secretEncrypted)
    const { attempts, outcome } = await attemptUntilDelivered({
      url: webhook.url,
      body: text,
      headers: deliveryHeaders(envelope, signDeliveryBody(secret, text)),
    })

    if (!outcome.delivered) {
      dependencies.log.warn('webhook delivery failed', {
        webhookId: webhook.id,
        deliveryId,
        event: payload.event,
        attempts,
        status: outcome.status,
        reason: outcome.reason,
      })
    }

    // The body is stored as it was sent, so the log answers "what did they
    // actually receive" rather than "what would we build for this event today".
    await record(webhook, payload, { id: deliveryId, sentAt: envelope.sentAt, body, attempts, outcome })
  }

  return {
    async deliver(payload) {
      const subscribed = await repository.listSubscribed(
        dependencies.db,
        payload.workspaceId,
        payload.event,
      )

      if (subscribed.length === 0) {
        return
      }

      // One unreachable endpoint, or one row whose secret will not decrypt,
      // must not stop the others. Same reason the bus settles its handlers
      // rather than racing them.
      const outcomes = await Promise.allSettled(
        subscribed.map((webhook) => deliverTo(webhook, payload)),
      )

      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === 'rejected') {
          dependencies.log.error('webhook delivery could not be attempted', {
            webhookId: subscribed[index]?.id,
            event: payload.event,
            error: describeThrown(outcome.reason),
          })
        }
      }
    },
  }
}

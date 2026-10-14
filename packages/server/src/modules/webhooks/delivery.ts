import { WEBHOOK_EVENTS } from '@kelpie/schemas'
import { z } from 'zod'

import type { Database } from '../../lib/database.ts'
import { BlockedEgressError } from '../../lib/egress.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { describeThrown, describeThrownWithCause } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { JobDefinition, JobHandle } from '../../lib/jobs.ts'
import type { Logger } from '../../lib/logger.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { WebhookEventPayload } from './payloads.ts'
import * as repository from './repository.ts'
import type { WebhookRecord } from './repository.ts'
import { deliveryBody, deliveryHeaders, renderDeliveryBody, signDeliveryBody } from './signing.ts'
import type { DeliveryEnvelope } from './signing.ts'

/**
 * Webhook delivery: a consumer of the internal event bus that turns one
 * domain event into one signed HTTP request per subscribed webhook.
 *
 * Two halves. The bus handler (`createDeliveryFanOut`) lists the subscribed
 * registrations and enqueues one `webhooks.deliver` job for each, in one
 * transaction. It sends nothing, so it stays far inside the time the bus
 * gives a handler. The job (`defineDeliveryJob`) makes one attempt each time
 * it runs, and the queue retries it. The jobs are rows in Postgres, so a
 * restart or a deploy does not lose a delivery that is waiting or retrying.
 *
 * Delivery is at-least-once. A worker that posted and then stopped before the
 * queue heard runs the attempt again. The delivery id is made once, at
 * enqueue, so every attempt carries the same `id` and a receiver can dedupe.
 * The body is built and signed again for each attempt: `created_at` is the
 * time of that attempt, so a body never goes stale while it waits in the
 * queue.
 *
 * Each attempt reads the registration again. A delivery for a registration
 * that has been paused, deleted, or no longer takes the event sends nothing
 * and writes nothing. The URL and the secrets are the ones the registration
 * has at that attempt. No delivery result is ever written over `paused`.
 *
 * Fairness. The jobs of one workspace are one pg-boss group, and the queue
 * runs at most `DELIVERY_GROUP_CONCURRENCY` of a group at a time. One
 * workspace's backlog cannot hold every worker.
 *
 * There is no limit on how many delivery jobs a workspace may have waiting.
 * A workspace can thus fill the jobs table: a 10,000 row import into a
 * workspace with 20 registrations for `record.created` is 200,000 jobs. The
 * group limit keeps that from starving other workspaces, but the rows and the
 * time to work through them are real.
 */

export const DELIVER_WEBHOOK_JOB = 'webhooks.deliver'

/** How long one attempt may take before it counts as failed. */
export const DELIVERY_TIMEOUT_MS = 10_000

/**
 * The retry schedule, in pg-boss's terms. `retryLimit: 3` is four attempts.
 *
 * With backoff, pg-boss waits `retryDelay * 2^r * (1 + random())` seconds,
 * capped at `retryDelayMax`, after a failure of the run with `retryCount` r
 * (0 on the first run). That is at most 10, 20 and then 40 seconds. A
 * retried job is found by the worker's poll, not by NOTIFY, so each wait can
 * be up to one poll (2 s) longer, and the retry may wait for a free slot of
 * its workspace's group, at most one attempt (10 s). The worst case from the
 * start of the first attempt to the end of the last is then:
 *
 *   4 attempts × 10 s + (10 + 20 + 40) s + 3 × (2 + 10) s = 146 s
 *
 * A receiver keeps an `id` until its `created_at` plus 5 minutes. Every
 * attempt must land inside that window of the first, and 146 s is under half
 * of it. The DNS lookup of the egress check runs outside the 10 s timeout and
 * is not counted here. A worker that dies during an attempt is not counted
 * either: supervision puts the job back only after `expireInSeconds` plus up
 * to two supervision intervals.
 */
export const DELIVERY_RETRY_LIMIT = 3
export const DELIVERY_RETRY_DELAY_SECONDS = 5
export const DELIVERY_RETRY_DELAY_MAX_SECONDS = 40

/**
 * When the queue counts a running attempt as lost. Three times the send
 * timeout, so a slow attempt plus its reads and its log write finishes well
 * before it.
 */
export const DELIVERY_EXPIRE_SECONDS = 30

/**
 * Deliveries one worker process runs at the same time, and the most one
 * workspace may hold across all processes.
 *
 * An attempt is almost all waiting on the endpoint, up to 10 s, so 10 per
 * process costs little memory or CPU. A group limit of 3 leaves 7 of the 10
 * slots of one worker for other workspaces when one workspace has a large
 * backlog, and still lets that workspace send 3 at a time. It must stay
 * below the local concurrency, or one workspace can fill a worker.
 */
export const DELIVERY_LOCAL_CONCURRENCY = 10
export const DELIVERY_GROUP_CONCURRENCY = 3

const DAY_MS = 86_400_000

/** What an unset `WEBHOOK_DELIVERY_RETENTION_DAYS` means. */
export const DEFAULT_DELIVERY_RETENTION_DAYS = 30

/**
 * The environment slice for the delivery log's retention window. Validated at
 * boot through `context.config`, so a malformed value stops the service with
 * the module named rather than quietly pruning by the wrong window.
 *
 * Optional with a stated default, unlike most of the environment: absence is
 * the normal state for an operator who does not care how long the log is, and
 * the README's configuration table carries the default so it is not silent.
 * Blank counts as absent, the `SECRET_ENCRYPTION_KEY_PREVIOUS` rule: operators
 * empty a line far more often than they delete it.
 */
export const deliveryRetentionConfigSchema = z.object({
  WEBHOOK_DELIVERY_RETENTION_DAYS: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim().length === 0 ? undefined : value))
    .refine(
      (value) => value === undefined || (Number.isInteger(Number(value)) && Number(value) >= 1),
      { message: 'must be a whole number of days, at least 1' },
    )
    .transform((value) =>
      value === undefined ? DEFAULT_DELIVERY_RETENTION_DAYS : Number(value),
    ),
})

export type DeliveryRetentionConfig = z.infer<typeof deliveryRetentionConfigSchema>

/** The moment a log row written before has outlived its retention. */
export function retentionCutoff(at: Date, retentionDays: number): Date {
  return new Date(at.getTime() - retentionDays * DAY_MS)
}

/**
 * One delivery job: one event for one registration.
 *
 * Ids and the event's `data`, which holds the record's type and id and never
 * the record (`payloads.ts`). The URL and the secrets are not here: an
 * attempt reads them from the registration, so a job waiting in `pgboss.job`
 * holds nothing a receiver could not already read from a delivery.
 */
export const deliveryJobDataSchema = z
  .object({
    workspaceId: z.string().min(1),
    webhookId: z.string().min(1),
    deliveryId: z.string().min(1),
    event: z.enum(WEBHOOK_EVENTS),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()

export type DeliveryJobData = z.infer<typeof deliveryJobDataSchema>

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

/**
 * What the sender answers: the outcome of the attempt, and what only the
 * server log may hold. An admin of the workspace reads the delivery log, and
 * the address a host resolved to would tell that admin what a name points at
 * inside the deployment's network.
 */
export interface SendOutcome extends AttemptOutcome {
  /** The address the egress guard refused. Absent on every other outcome. */
  readonly blockedAddress?: string
}

/** The outbound port. Injected so no test makes a network call. */
export type SendDelivery = (request: DeliveryRequest) => Promise<SendOutcome>

/**
 * Lets go of a response body nobody reads, so its connection goes back to the
 * pool rather than waiting for the garbage collector.
 *
 * Not awaited, and a refusal is dropped on purpose: the status is all the
 * attempt needed, a body that fails to close changes no outcome, and the
 * attempt must not wait on an endpoint that keeps sending.
 */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined)
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
 * reason reaches the log and the delivery is recorded as failed. The reason
 * names the network fault by its code (`describeThrownWithCause`) and never
 * by an address. A blocked private address (`egress.check`, or the guard's
 * `fetch` at the connection) reaches the same catch and is recorded the same
 * way, as a failed attempt rather than a crash, with the address beside the
 * reason for the server log only.
 */
export function createHttpSender(
  egress: EgressGuard,
  fetchImplementation: typeof fetch = egress.fetch,
): SendDelivery {
  return async (request) => {
    try {
      await egress.check(request.url)

      const response = await fetchImplementation(request.url, {
        method: 'POST',
        body: request.body,
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      })

      discardBody(response)

      return response.ok
        ? { delivered: true, status: response.status, reason: null }
        : {
            delivered: false,
            status: response.status,
            reason: `endpoint answered ${String(response.status)}`,
          }
    } catch (error: unknown) {
      const failed = { delivered: false, status: null, reason: describeThrownWithCause(error) }

      return error instanceof BlockedEgressError ? { ...failed, blockedAddress: error.address } : failed
    }
  }
}

export interface DeliveryDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly now: () => Date
  readonly cipher: SecretCipher
  readonly send: SendDelivery
  /** From `deliveryRetentionConfigSchema`, validated at boot. */
  readonly retentionDays: number
  readonly log: Logger
}

/** What one attempt is: which run of the job, and whether the queue tries again. */
export interface AttemptRun {
  /** 1 on the first attempt. */
  readonly attempt: number
  /** True when the queue does not run the job again if this attempt fails. */
  readonly lastAttempt: boolean
  readonly log: Logger
}

/** One delivery to write to the log. */
interface DeliveryResult {
  readonly data: DeliveryJobData
  readonly sentAt: Date
  readonly body: Record<string, unknown>
  readonly attempts: number
  readonly outcome: AttemptOutcome
  /**
   * False when the fault is Kelpie's and not the endpoint's: the row is
   * written, and the registration's status stays as it is.
   */
  readonly moveStatus: boolean
}

/**
 * Writes the outcome: one log row, the expired rows gone, and the webhook's
 * status when it moved.
 *
 * One transaction, so a reader never sees a hook marked failing with no
 * failure recorded against it.
 *
 * A registration deleted since the delivery began gets nothing written: its
 * log went with it, and a row for it would break the foreign key. A delivery
 * already in the log gets nothing written either, so a repeat of this
 * function, from a retried job or from the dead-letter handler, is harmless.
 *
 * Retention is enforced here rather than by a schedule because there is no
 * scheduler in the service, and the log only grows through this function —
 * pruning on every append caps the table exactly where the growth happens.
 * The cost is the documented residue: a hook that stops delivering keeps its
 * last window of rows until the hook or the workspace is deleted.
 */
async function record(dependencies: DeliveryDependencies, result: DeliveryResult): Promise<void> {
  const { data, outcome } = result

  const pruned = await dependencies.transaction(async ({ tx }) => {
    if (!(await repository.holdWebhook(tx, data.workspaceId, data.webhookId))) {
      return undefined
    }

    const written = await repository.insertDelivery(tx, {
      id: data.deliveryId,
      workspaceId: data.workspaceId,
      webhookId: data.webhookId,
      event: data.event,
      payload: result.body,
      status: outcome.delivered ? 'success' : 'failed',
      attempts: result.attempts,
      // `created_at` is the `created_at` inside the body stored beside it:
      // the body of the attempt this row reports, so the log and what the
      // receiver last got agree. `delivered_at` is when that attempt landed.
      deliveredAt: outcome.delivered ? dependencies.now() : null,
      createdAt: result.sentAt,
    })

    if (written === undefined) {
      return 0
    }

    // The cutoff is later than the row above's `created_at` for any positive
    // window, so a prune can never take the delivery it arrived with, and
    // `last_delivery_*` always has a row to read.
    const expired = await repository.deleteExpiredDeliveries(
      tx,
      data.webhookId,
      retentionCutoff(dependencies.now(), dependencies.retentionDays),
    )

    // The statement itself leaves `paused` and an unchanged status alone.
    if (result.moveStatus) {
      await repository.setWebhookStatus(tx, data.webhookId, outcome.delivered ? 'active' : 'failing')
    }

    return expired
  })

  if (pruned === undefined) {
    dependencies.log.debug('webhook delivery not recorded: the webhook was deleted', {
      webhookId: data.webhookId,
      deliveryId: data.deliveryId,
      event: data.event,
    })

    return
  }

  // After the transaction settles: a rollback would make this line a lie.
  if (pruned > 0) {
    dependencies.log.debug('pruned expired webhook deliveries', { webhookId: data.webhookId, pruned })
  }
}

/**
 * The registration, when this delivery should still go to it: it exists in
 * the job's workspace, it is not paused, and it still takes the event.
 * `failing` still gets deliveries, the `listSubscribed` rule.
 */
async function findDeliverable(
  dependencies: DeliveryDependencies,
  data: DeliveryJobData,
): Promise<WebhookRecord | undefined> {
  const webhook = await repository.findWebhook(dependencies.db, data.workspaceId, data.webhookId)

  if (webhook === undefined || webhook.status === 'paused' || !webhook.events.includes(data.event)) {
    return undefined
  }

  return webhook
}

/**
 * Every signature this body should carry, newest secret first.
 *
 * The expiry of an overlap is read here rather than swept by a job. An overlap
 * that has run out simply stops being signed with; the column is cleared by
 * the next rotation or by deleting the registration.
 *
 * @throws SecretDecryptionError when a secret will not open under the keys the
 *   service holds.
 */
function signaturesFor(
  cipher: SecretCipher,
  webhook: WebhookRecord,
  text: string,
  at: Date,
): readonly string[] {
  const signatures = [signDeliveryBody(cipher.open(webhook.secretEncrypted), text)]
  const expiresAt = webhook.previousSecretExpiresAt

  if (webhook.previousSecretEncrypted !== null && expiresAt !== null && expiresAt > at) {
    signatures.push(signDeliveryBody(cipher.open(webhook.previousSecretEncrypted), text))
  }

  return signatures
}

function envelopeFor(data: DeliveryJobData, sentAt: Date): DeliveryEnvelope {
  return {
    deliveryId: data.deliveryId,
    event: data.event,
    sentAt,
    workspaceId: data.workspaceId,
    data: data.data,
  }
}

interface BuiltAttempt {
  readonly request: DeliveryRequest
  readonly sentAt: Date
  readonly body: Record<string, unknown>
}

/**
 * The request for this attempt: a body with this attempt's `created_at`, and
 * signatures over it under the secrets the registration holds now.
 *
 * @returns Undefined when a secret will not decrypt. That fault is Kelpie's
 *   key, not the endpoint: it is logged at `error`, nothing is recorded, and
 *   the registration is not marked `failing`, which would send the customer
 *   debugging a healthy server. A retry cannot fix a key, so the caller ends
 *   the job.
 */
function buildAttempt(
  dependencies: DeliveryDependencies,
  webhook: WebhookRecord,
  data: DeliveryJobData,
  log: Logger,
): BuiltAttempt | undefined {
  const sentAt = dependencies.now()
  const envelope = envelopeFor(data, sentAt)
  const body = deliveryBody(envelope)
  const text = renderDeliveryBody(body)

  try {
    const signatures = signaturesFor(dependencies.cipher, webhook, text, sentAt)

    return { request: { url: webhook.url, body: text, headers: deliveryHeaders(envelope, signatures) }, sentAt, body }
  } catch (error: unknown) {
    if (!(error instanceof SecretDecryptionError)) {
      throw error
    }

    log.error('webhook delivery dropped: the signing secret could not be decrypted', {
      webhookId: data.webhookId,
      deliveryId: data.deliveryId,
      error: describeThrown(error),
    })

    return undefined
  }
}

/**
 * One attempt of one delivery. The job's handler; exported so a test can run
 * it without a worker.
 *
 * Sends nothing when the registration no longer takes this delivery, or when
 * the log already holds it (an earlier run recorded it and then stopped
 * before the queue heard).
 *
 * @throws Error when the attempt failed and the queue will try again. Nothing
 *   is recorded until the delivery lands or the last attempt fails, so the log
 *   holds one row per delivery, with the number of attempts it took.
 */
export async function attemptDelivery(
  dependencies: DeliveryDependencies,
  data: DeliveryJobData,
  run: AttemptRun,
): Promise<void> {
  const webhook = await findDeliverable(dependencies, data)

  if (webhook === undefined || (await repository.deliveryExists(dependencies.db, data.deliveryId))) {
    run.log.debug('webhook delivery skipped: no longer due', {
      webhookId: data.webhookId,
      deliveryId: data.deliveryId,
      event: data.event,
    })

    return
  }

  const built = buildAttempt(dependencies, webhook, data, run.log)

  if (built === undefined) {
    return
  }

  const outcome = await dependencies.send(built.request)

  if (!outcome.delivered) {
    run.log.warn('webhook delivery attempt failed', {
      webhookId: data.webhookId,
      deliveryId: data.deliveryId,
      event: data.event,
      attempt: run.attempt,
      lastAttempt: run.lastAttempt,
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.blockedAddress === undefined ? {} : { blockedAddress: outcome.blockedAddress }),
    })

    if (!run.lastAttempt) {
      throw new Error(
        `webhook delivery ${data.deliveryId} attempt ${String(run.attempt)} failed: ${outcome.reason ?? 'no reason'}`,
      )
    }
  }

  // The last failed attempt records and returns rather than throwing. The
  // failure is the endpoint's, and it is in the delivery log; a dead-letter
  // row for it would fill the operators' queue with customers' outages.
  await record(dependencies, {
    data,
    sentAt: built.sentAt,
    body: built.body,
    attempts: run.attempt,
    outcome: { delivered: outcome.delivered, status: outcome.status, reason: outcome.reason },
    moveStatus: true,
  })
}

/** The reason in the log for a delivery whose last attempt never finished. */
export const ABANDONED_DELIVERY_REASON = 'The last attempt did not finish: the worker running it stopped'

/**
 * The dead-letter handler: a delivery job the queue gave up on.
 *
 * The handler records every ending it sees (a success, or a failure on the
 * last attempt), and ends the job for a secret that will not decrypt. So a
 * job gets here when no handler finished its last run: the worker died, or
 * the run threw on something other than the endpoint, such as the database.
 *
 * Writes one failed row when the log has none for this delivery, and the
 * registration still takes it. It does not move the registration to
 * `failing`: the endpoint did not fail, Kelpie stopped. Safe to run more than
 * once: the insert does nothing for a delivery already in the log.
 *
 * It cannot see why the last run ended. It opens the secret again: when that
 * fails, no attempt could have been signed, the fault is the key, and
 * nothing is written, the rule `buildAttempt` keeps.
 */
export async function recordAbandonedDelivery(
  dependencies: DeliveryDependencies,
  data: DeliveryJobData,
  log: Logger,
): Promise<void> {
  const webhook = await findDeliverable(dependencies, data)

  if (webhook === undefined || (await repository.deliveryExists(dependencies.db, data.deliveryId))) {
    return
  }

  // Built only to open the secrets; nothing is sent.
  const built = buildAttempt(dependencies, webhook, data, log)

  if (built === undefined) {
    return
  }

  log.warn('webhook delivery abandoned: its last attempt did not finish', {
    webhookId: data.webhookId,
    deliveryId: data.deliveryId,
    event: data.event,
    reason: ABANDONED_DELIVERY_REASON,
  })

  await record(dependencies, {
    data,
    sentAt: built.sentAt,
    body: built.body,
    // The queue dead-letters a job only after its last run.
    attempts: DELIVERY_RETRY_LIMIT + 1,
    outcome: { delivered: false, status: null, reason: ABANDONED_DELIVERY_REASON },
    moveStatus: false,
  })
}

export function defineDeliveryJob(dependencies: DeliveryDependencies): JobDefinition<DeliveryJobData> {
  return {
    name: DELIVER_WEBHOOK_JOB,
    schema: deliveryJobDataSchema,
    defaults: {
      retryLimit: DELIVERY_RETRY_LIMIT,
      retryDelay: DELIVERY_RETRY_DELAY_SECONDS,
      retryBackoff: true,
      retryDelayMax: DELIVERY_RETRY_DELAY_MAX_SECONDS,
      expireInSeconds: DELIVERY_EXPIRE_SECONDS,
      localConcurrency: DELIVERY_LOCAL_CONCURRENCY,
      groupConcurrency: DELIVERY_GROUP_CONCURRENCY,
    },
    handler: ({ data, log, attempt, lastAttempt }) =>
      attemptDelivery(dependencies, data, {
        attempt: attempt ?? 1,
        lastAttempt: lastAttempt === true,
        log,
      }),
    onDeadLetter: ({ data, log }) => recordAbandonedDelivery(dependencies, data, log),
  }
}

export interface FanOutDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly deliveryJob: JobHandle<DeliveryJobData>
}

/** The bus side: one event in, one job per subscribed registration out. */
export interface DeliveryFanOut {
  enqueue(payload: WebhookEventPayload): Promise<void>
}

/**
 * The bus handler. It only reads and enqueues; it never waits on an endpoint.
 *
 * At most `WEBHOOK_MAX_PER_WORKSPACE` registrations (20 unless set), so one
 * event is at most that many inserts, in one transaction: an event either
 * reaches every subscribed registration or none, and a failure leaves the
 * bus to log it.
 */
export function createDeliveryFanOut(dependencies: FanOutDependencies): DeliveryFanOut {
  return {
    async enqueue(payload) {
      const subscribed = await repository.listSubscribed(dependencies.db, payload.workspaceId, payload.event)

      if (subscribed.length === 0) {
        return
      }

      await dependencies.transaction(async ({ jobs }) => {
        for (const webhook of subscribed) {
          await jobs.enqueue(
            dependencies.deliveryJob,
            jobDataFor(payload, webhook.id, dependencies.createId('webhookDelivery')),
            { group: { id: payload.workspaceId } },
          )
        }
      })
    },
  }
}

function jobDataFor(payload: WebhookEventPayload, webhookId: string, deliveryId: string): DeliveryJobData {
  return { workspaceId: payload.workspaceId, webhookId, deliveryId, event: payload.event, data: payload.data }
}

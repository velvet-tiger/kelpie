import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  DELIVERY_EXPIRE_SECONDS,
  DELIVERY_GROUP_CONCURRENCY,
  DELIVERY_LOCAL_CONCURRENCY,
  DELIVERY_RETRY_DELAY_MAX_SECONDS,
  DELIVERY_RETRY_DELAY_SECONDS,
  DELIVERY_RETRY_LIMIT,
  DELIVERY_TIMEOUT_MS,
  createHttpSender,
  deliveryJobDataSchema,
  deliveryRetentionConfigSchema,
  retentionCutoff,
} from './delivery.ts'
import type { DeliveryRequest } from './delivery.ts'
import { createEgressGuard } from '../../lib/egress.ts'

/**
 * The pure halves of the engine. Fanning out, recording and status transitions
 * need real rows, so they are asserted in `webhooks.test.ts` against Postgres.
 */

const request: DeliveryRequest = {
  url: 'https://example.com/hooks',
  body: '{"id":"whd_01"}',
  headers: { 'Content-Type': 'application/json' },
}

/**
 * The longest pg-boss can wait after the failed run with `retryCount` r, by
 * its own formula: `retryDelay * 2^r * (1 + random())`, capped.
 */
function longestWaitAfter(retryCount: number): number {
  return Math.min(DELIVERY_RETRY_DELAY_MAX_SECONDS, DELIVERY_RETRY_DELAY_SECONDS * 2 ** (retryCount + 1))
}

describe('the retry schedule', () => {
  /** The worker's poll, which is how a retried job is found. */
  const POLL_SECONDS = 2
  const ATTEMPT_SECONDS = DELIVERY_TIMEOUT_MS / 1000

  /**
   * A receiver keeps a delivery id until its `created_at` plus 5 minutes, so
   * every attempt must land well inside 5 minutes of the first. The sum is the
   * one the comment on `DELIVERY_RETRY_LIMIT` states.
   */
  it('lands the last attempt within half of the five minute dedupe window', () => {
    const retries = Array.from({ length: DELIVERY_RETRY_LIMIT }, (_, retryCount) => retryCount)
    const waiting = retries.reduce((sum, retryCount) => sum + longestWaitAfter(retryCount), 0)
    // Each retry may also wait one poll, and one attempt for a free slot of its group.
    const queueing = DELIVERY_RETRY_LIMIT * (POLL_SECONDS + ATTEMPT_SECONDS)
    const worstCase = (DELIVERY_RETRY_LIMIT + 1) * ATTEMPT_SECONDS + waiting + queueing

    expect(waiting).toBe(70)
    expect(worstCase).toBe(146)
    expect(worstCase).toBeLessThan(150)
  })

  it('gives an attempt longer than the send timeout before the queue counts it lost', () => {
    expect(DELIVERY_EXPIRE_SECONDS).toBeGreaterThanOrEqual(3 * ATTEMPT_SECONDS)
  })

  it('leaves free slots on a worker when one workspace has a backlog', () => {
    expect(DELIVERY_GROUP_CONCURRENCY).toBeLessThan(DELIVERY_LOCAL_CONCURRENCY)
  })
})

describe('deliveryRetentionConfigSchema', () => {
  function windowFrom(environment: Record<string, string>): number {
    return deliveryRetentionConfigSchema.parse(environment).WEBHOOK_DELIVERY_RETENTION_DAYS
  }

  it('defaults when the variable is unset, and when it is blank', () => {
    expect(windowFrom({})).toBe(DEFAULT_DELIVERY_RETENTION_DAYS)
    // Blank counts as absent: operators empty a line rather than delete it.
    expect(windowFrom({ WEBHOOK_DELIVERY_RETENTION_DAYS: '  ' })).toBe(
      DEFAULT_DELIVERY_RETENTION_DAYS,
    )
  })

  it('reads a whole number of days', () => {
    expect(windowFrom({ WEBHOOK_DELIVERY_RETENTION_DAYS: '7' })).toBe(7)
    expect(windowFrom({ WEBHOOK_DELIVERY_RETENTION_DAYS: '365' })).toBe(365)
  })

  /** A malformed value stops boot rather than pruning by the wrong window. */
  it('refuses zero, negatives, fractions, and words', () => {
    for (const value of ['0', '-1', '7.5', 'monthly', 'NaN']) {
      expect(
        deliveryRetentionConfigSchema.safeParse({ WEBHOOK_DELIVERY_RETENTION_DAYS: value })
          .success,
      ).toBe(false)
    }
  })
})

describe('retentionCutoff', () => {
  it('reaches back exactly the window', () => {
    const at = new Date('2026-08-06T00:00:00Z')

    expect(retentionCutoff(at, 30)).toEqual(new Date('2026-07-07T00:00:00Z'))
    expect(retentionCutoff(at, 1)).toEqual(new Date('2026-08-05T00:00:00Z'))
  })
})

describe('createHttpSender', () => {
  const allowAll = createEgressGuard({ BLOCK_PRIVATE_EGRESS: false })

  function respondWith(status: number): typeof fetch {
    return () => Promise.resolve(new Response(null, { status }))
  }

  it('treats a 2xx as delivered', async () => {
    const send = createHttpSender(allowAll, respondWith(204))

    expect(await send(request)).toEqual({ delivered: true, status: 204, reason: null })
  })

  it('treats a 4xx and a 5xx as failed, keeping the status for the log', async () => {
    expect(await createHttpSender(allowAll, respondWith(410))(request)).toEqual({
      delivered: false,
      status: 410,
      reason: 'endpoint answered 410',
    })
    expect((await createHttpSender(allowAll, respondWith(503))(request)).delivered).toBe(false)
  })

  /**
   * Redirects are not followed, so a moved endpoint is reported rather than
   * silently posting workspace data wherever the old address now points.
   */
  it('treats a redirect as failed', async () => {
    const send = createHttpSender(
      allowAll,
      () => Promise.resolve(new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example' } })),
    )

    expect((await send(request)).status).toBe(301)
  })

  it('turns a transport failure into an outcome rather than a rejection', async () => {
    const send = createHttpSender(allowAll, () => Promise.reject(new TypeError('fetch failed')))

    expect(await send(request)).toEqual({
      delivered: false,
      status: null,
      reason: 'TypeError: fetch failed',
    })
  })

  /** The reason is in the delivery log, which an admin of the workspace reads. */
  it('names the network fault by its code, and never by the address it connected to', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' })
    const send = createHttpSender(allowAll, () => Promise.reject(new TypeError('fetch failed', { cause })))
    const outcome = await send(request)

    expect(outcome.reason).toBe('TypeError: fetch failed (ECONNREFUSED)')
    expect(outcome.reason).not.toContain('10.0.0.5')
  })

  it('lets go of the response body without reading it', async () => {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const send = createHttpSender(allowAll, () => Promise.resolve(new Response(body, { status: 500 })))

    expect((await send(request)).status).toBe(500)
    await expect.poll(() => cancelled).toBe(true)
  })

  it('answers with the status when the body refuses to close', async () => {
    const body = new ReadableStream({
      cancel() {
        throw new Error('the stream would not close')
      },
    })
    const send = createHttpSender(allowAll, () => Promise.resolve(new Response(body, { status: 200 })))

    expect(await send(request)).toEqual({ delivered: true, status: 200, reason: null })
  })

  it('records a blocked private address as a failed attempt, and never fetches', async () => {
    const blockAll = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () => Promise.resolve(['127.0.0.1']))
    let fetched = false
    const send = createHttpSender(blockAll, () => {
      fetched = true

      return Promise.resolve(new Response(null, { status: 200 }))
    })

    const outcome = await send(request)

    expect(fetched).toBe(false)
    expect(outcome.delivered).toBe(false)
    expect(outcome.status).toBeNull()
    expect(outcome.reason).toContain('private or reserved')
    // The address is for the server log. The reason is what a customer may read.
    expect(outcome.reason).not.toContain('127.0.0.1')
    expect(outcome.blockedAddress).toBe('127.0.0.1')
  })

  it('posts the body and headers it was given', async () => {
    // `| undefined` on both: `fetch` declares `init` optional, so the stub is
    // handed `RequestInit | undefined` and records exactly that.
    const seen: { url?: string | undefined; init?: RequestInit | undefined } = {}
    const send = createHttpSender(allowAll, (url, init) => {
      seen.url = String(url)
      seen.init = init

      return Promise.resolve(new Response(null, { status: 200 }))
    })

    await send(request)

    expect(seen.url).toBe('https://example.com/hooks')
    expect(seen.init?.method).toBe('POST')
    expect(seen.init?.body).toBe('{"id":"whd_01"}')
    expect(seen.init?.redirect).toBe('manual')
  })
})

describe('deliveryJobDataSchema', () => {
  const job = {
    workspaceId: 'ws_01',
    webhookId: 'wh_01',
    deliveryId: 'whd_01',
    event: 'record.created',
    data: { object_type: 'person', record_id: 'per_01' },
  }

  it('reads a job as the bus handler writes it', () => {
    expect(deliveryJobDataSchema.parse(job)).toEqual(job)
  })

  /** A payload that no longer parses is a Kelpie fault, never a delivery. */
  it('refuses an unknown event and an unknown key', () => {
    expect(deliveryJobDataSchema.safeParse({ ...job, event: 'record.archived' }).success).toBe(false)
    expect(deliveryJobDataSchema.safeParse({ ...job, url: 'https://example.com' }).success).toBe(false)
  })
})

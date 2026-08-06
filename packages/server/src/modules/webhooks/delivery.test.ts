import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DELIVERY_RETENTION_DAYS,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
  createHttpSender,
  deliveryRetentionConfigSchema,
  retentionCutoff,
  retryDelayAfter,
} from './delivery.ts'
import type { DeliveryRequest } from './delivery.ts'

/**
 * The pure halves of the engine. Fanning out, recording and status transitions
 * need real rows, so they are asserted in `webhooks.test.ts` against Postgres.
 */

const request: DeliveryRequest = {
  url: 'https://example.com/hooks',
  body: '{"id":"whd_01"}',
  headers: { 'Content-Type': 'application/json' },
}

describe('retryDelayAfter', () => {
  it('waits longer after each failure', () => {
    expect(RETRY_DELAYS_MS.every((delay, index) => index === 0 || delay > (RETRY_DELAYS_MS[index - 1] ?? 0))).toBe(true)
  })

  it('gives a delay after every attempt but the last', () => {
    for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts += 1) {
      expect(retryDelayAfter(attempts)).toBeGreaterThan(0)
    }
  })

  it('gives none once the budget is spent', () => {
    expect(retryDelayAfter(MAX_DELIVERY_ATTEMPTS)).toBeUndefined()
    expect(retryDelayAfter(MAX_DELIVERY_ATTEMPTS + 1)).toBeUndefined()
  })

  /** A long budget would hold graceful shutdown open waiting on a dead endpoint. */
  it('spends under a minute of waiting in total', () => {
    const total = RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)

    expect(total).toBeLessThan(60_000)
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
  function respondWith(status: number): typeof fetch {
    return () => Promise.resolve(new Response(null, { status }))
  }

  it('treats a 2xx as delivered', async () => {
    const send = createHttpSender(respondWith(204))

    expect(await send(request)).toEqual({ delivered: true, status: 204, reason: null })
  })

  it('treats a 4xx and a 5xx as failed, keeping the status for the log', async () => {
    expect(await createHttpSender(respondWith(410))(request)).toEqual({
      delivered: false,
      status: 410,
      reason: 'endpoint answered 410',
    })
    expect((await createHttpSender(respondWith(503))(request)).delivered).toBe(false)
  })

  /**
   * Redirects are not followed, so a moved endpoint is reported rather than
   * silently posting workspace data wherever the old address now points.
   */
  it('treats a redirect as failed', async () => {
    const send = createHttpSender(
      () => Promise.resolve(new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example' } })),
    )

    expect((await send(request)).status).toBe(301)
  })

  it('turns a transport failure into an outcome rather than a rejection', async () => {
    const send = createHttpSender(() => Promise.reject(new TypeError('fetch failed')))

    expect(await send(request)).toEqual({
      delivered: false,
      status: null,
      reason: 'TypeError: fetch failed',
    })
  })

  it('posts the body and headers it was given', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const send = createHttpSender((url, init) => {
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

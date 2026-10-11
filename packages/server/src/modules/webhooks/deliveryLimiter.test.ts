import { describe, expect, it } from 'vitest'

import { createDeliveryLimiter } from './deliveryLimiter.ts'
import type { LimitedOutcome } from './deliveryLimiter.ts'
import {
  DEFAULT_MAX_CONCURRENT_DELIVERIES,
  DEFAULT_MAX_WAITING_DELIVERIES,
  DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE,
  webhookLimitsConfigSchema,
} from './limits.ts'

/**
 * The limiter alone: no engine, no database, no clock. Each piece of work is a
 * promise the test settles by hand, so "at the same time" is exact and nothing
 * here waits on a timer.
 */

/** One piece of work the test finishes when it chooses. */
interface HeldWork {
  readonly work: () => Promise<string>
  started: boolean
  finish(): void
  fail(error: Error): void
}

function holdWork(label: string): HeldWork {
  let resolve: (value: string) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const settled = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  const held: HeldWork = {
    started: false,
    work: () => {
      held.started = true

      return settled
    },
    finish: () => {
      resolve(label)
    },
    fail: (error) => {
      reject(error)
    },
  }

  return held
}

/** Lets every promise that is already able to continue do so. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('createDeliveryLimiter', () => {
  it('runs work at once while a slot is free, and answers with its result', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 2, maxWaiting: 0 })

    expect(await limiter.run(() => Promise.resolve('sent'))).toEqual({ admitted: true, result: 'sent' })
  })

  it('never runs more than the maximum at one time', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 3, maxWaiting: 100 })
    let running = 0
    let most = 0
    const releases: (() => void)[] = []

    const all = Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        running += 1
        most = Math.max(most, running)

        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })

        running -= 1
      }),
    )

    // Finish them one at a time, so each freed slot is taken by a waiter
    // while the others are still running.
    for (let finished = 0; finished < 20; finished += 1) {
      await settle()
      expect(running).toBeLessThanOrEqual(3)
      releases.shift()?.()
    }

    const outcomes = await Promise.all(all)

    expect(most).toBe(3)
    expect(outcomes.every((outcome) => outcome.admitted)).toBe(true)
  })

  it('holds work in the line until a slot frees, in arrival order', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 2 })
    const first = holdWork('first')
    const second = holdWork('second')
    const third = holdWork('third')

    const outcomes = [limiter.run(first.work), limiter.run(second.work), limiter.run(third.work)]
    await settle()

    expect([first.started, second.started, third.started]).toEqual([true, false, false])

    first.finish()
    await settle()

    expect([second.started, third.started]).toEqual([true, false])

    second.finish()
    third.finish()

    expect(await Promise.all(outcomes)).toEqual([
      { admitted: true, result: 'first' },
      { admitted: true, result: 'second' },
      { admitted: true, result: 'third' },
    ])
  })

  it('refuses work past the waiting limit, and never calls it', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 1 })
    const running = holdWork('running')
    const waiting = holdWork('waiting')
    const refused = holdWork('refused')

    const admitted = [limiter.run(running.work), limiter.run(waiting.work)]
    const outcome = await limiter.run(refused.work)

    expect(outcome).toEqual({ admitted: false })
    expect(refused.started).toBe(false)

    running.finish()
    waiting.finish()
    await Promise.all(admitted)
  })

  it('refuses at once with a waiting limit of zero when every slot is in use', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 0 })
    const running = holdWork('running')
    const admitted = limiter.run(running.work)

    expect(await limiter.run(() => Promise.resolve('late'))).toEqual({ admitted: false })

    running.finish()
    await admitted
  })

  it('has room again once work finishes', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 0 })
    const running = holdWork('running')
    const admitted = limiter.run(running.work)

    expect((await limiter.run(() => Promise.resolve('refused'))).admitted).toBe(false)

    running.finish()
    await admitted

    expect(await limiter.run(() => Promise.resolve('next'))).toEqual({ admitted: true, result: 'next' })
  })

  /** A delivery that throws must not hold its slot for the life of the process. */
  it('frees the slot when the work throws, and passes the error on', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 1 })
    const failing = holdWork('failing')
    const waiting = holdWork('waiting')

    const failed = limiter.run(failing.work)
    const next = limiter.run(waiting.work)

    failing.fail(new Error('the row would not write'))

    await expect(failed).rejects.toThrow('the row would not write')
    await settle()

    expect(waiting.started).toBe(true)

    waiting.finish()

    expect(await next).toEqual({ admitted: true, result: 'waiting' })
  })

  /** A new arrival must not take a freed slot ahead of the work already waiting for it. */
  it('gives a freed slot to the line, not to work that arrives as it frees', async () => {
    const limiter = createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: 1 })
    const started: string[] = []
    const running = holdWork('running')
    const admitted = [
      limiter.run(running.work),
      limiter.run(() => {
        started.push('waiting')

        return Promise.resolve('waiting')
      }),
    ]
    let late: Promise<LimitedOutcome<string>> | undefined

    running.finish()
    // Queued behind the turn that frees the slot and ahead of the turn in
    // which the waiter resumes, which is the gap a late arrival could use.
    await Promise.resolve().then(() => {
      late = limiter.run(() => {
        started.push('late')

        return Promise.resolve('late')
      })
    })
    await Promise.all(admitted)

    expect(await late).toEqual({ admitted: true, result: 'late' })
    expect(started).toEqual(['waiting', 'late'])
  })

  it('refuses limits that could never run anything', () => {
    expect(() => createDeliveryLimiter({ maxConcurrent: 0, maxWaiting: 1 })).toThrow(RangeError)
    expect(() => createDeliveryLimiter({ maxConcurrent: 1.5, maxWaiting: 1 })).toThrow(RangeError)
    expect(() => createDeliveryLimiter({ maxConcurrent: 1, maxWaiting: -1 })).toThrow(RangeError)
  })
})

describe('webhookLimitsConfigSchema', () => {
  it('defaults when the variables are unset, and when they are blank', () => {
    const defaults = {
      WEBHOOK_MAX_PER_WORKSPACE: DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES: DEFAULT_MAX_CONCURRENT_DELIVERIES,
      WEBHOOK_MAX_WAITING_DELIVERIES: DEFAULT_MAX_WAITING_DELIVERIES,
    }

    expect(webhookLimitsConfigSchema.parse({})).toEqual(defaults)
    // Blank counts as absent: operators empty a line rather than delete it.
    expect(
      webhookLimitsConfigSchema.parse({
        WEBHOOK_MAX_PER_WORKSPACE: '',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '  ',
        WEBHOOK_MAX_WAITING_DELIVERIES: '',
      }),
    ).toEqual(defaults)
  })

  it('keeps the documented defaults', () => {
    expect(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE).toBe(20)
    expect(DEFAULT_MAX_CONCURRENT_DELIVERIES).toBe(20)
    expect(DEFAULT_MAX_WAITING_DELIVERIES).toBe(1_000)
  })

  it('reads whole numbers', () => {
    expect(
      webhookLimitsConfigSchema.parse({
        WEBHOOK_MAX_PER_WORKSPACE: '5',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '50',
        WEBHOOK_MAX_WAITING_DELIVERIES: '0',
      }),
    ).toEqual({
      WEBHOOK_MAX_PER_WORKSPACE: 5,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES: 50,
      WEBHOOK_MAX_WAITING_DELIVERIES: 0,
    })
  })

  /** A malformed value stops boot rather than running with no limit. */
  it('refuses negatives, fractions and words, and a zero where zero means nothing can run', () => {
    for (const name of [
      'WEBHOOK_MAX_PER_WORKSPACE',
      'WEBHOOK_MAX_CONCURRENT_DELIVERIES',
      'WEBHOOK_MAX_WAITING_DELIVERIES',
    ]) {
      for (const value of ['-1', '2.5', 'many', 'NaN', 'Infinity']) {
        expect(webhookLimitsConfigSchema.safeParse({ [name]: value }).success).toBe(false)
      }
    }

    expect(webhookLimitsConfigSchema.safeParse({ WEBHOOK_MAX_PER_WORKSPACE: '0' }).success).toBe(false)
    expect(webhookLimitsConfigSchema.safeParse({ WEBHOOK_MAX_CONCURRENT_DELIVERIES: '0' }).success).toBe(false)
  })
})

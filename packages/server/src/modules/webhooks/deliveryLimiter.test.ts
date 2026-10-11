import { describe, expect, it } from 'vitest'

import { createDeliveryLimiter } from './deliveryLimiter.ts'
import type { DeliveryLimits, LimitedOutcome } from './deliveryLimiter.ts'
import {
  DEFAULT_MAX_CONCURRENT_DELIVERIES,
  DEFAULT_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE,
  DEFAULT_MAX_WAITING_DELIVERIES,
  DEFAULT_MAX_WAITING_DELIVERIES_PER_WORKSPACE,
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

/** Limits under which one workspace may have everything, for the tests of the process limits alone. */
function unshared(maxConcurrent: number, maxWaiting: number): DeliveryLimits {
  return {
    maxConcurrent,
    maxWaiting,
    maxConcurrentPerWorkspace: maxConcurrent,
    maxWaitingPerWorkspace: maxWaiting,
  }
}

const ACME = 'ws_acme'
const OTHER = 'ws_other'

/** Stands in for work an array index should have held, so a missing one fails loudly. */
function noWork(): Promise<string> {
  return Promise.reject(new Error('the test built no work for this place'))
}

/** Lets every promise that is already able to continue do so. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('createDeliveryLimiter', () => {
  it('runs work at once while a slot is free, and answers with its result', async () => {
    const limiter = createDeliveryLimiter(unshared(2, 0))

    expect(await limiter.run(ACME, () => Promise.resolve('sent'))).toEqual({ admitted: true, result: 'sent' })
  })

  it('never runs more than the maximum at one time', async () => {
    const limiter = createDeliveryLimiter(unshared(3, 100))
    let running = 0
    let most = 0
    const releases: (() => void)[] = []

    const all = Array.from({ length: 20 }, () =>
      limiter.run(ACME, async () => {
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
    const limiter = createDeliveryLimiter(unshared(1, 2))
    const first = holdWork('first')
    const second = holdWork('second')
    const third = holdWork('third')

    const outcomes = [limiter.run(ACME, first.work), limiter.run(ACME, second.work), limiter.run(ACME, third.work)]
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
    const limiter = createDeliveryLimiter(unshared(1, 1))
    const running = holdWork('running')
    const waiting = holdWork('waiting')
    const refused = holdWork('refused')

    const admitted = [limiter.run(ACME, running.work), limiter.run(ACME, waiting.work)]
    const outcome = await limiter.run(ACME, refused.work)

    expect(outcome).toEqual({ admitted: false, limit: 'workspace' })
    expect(refused.started).toBe(false)

    running.finish()
    waiting.finish()
    await Promise.all(admitted)
  })

  it('refuses at once with a waiting limit of zero when every slot is in use', async () => {
    const limiter = createDeliveryLimiter(unshared(1, 0))
    const running = holdWork('running')
    const admitted = limiter.run(ACME, running.work)

    expect(await limiter.run(ACME, () => Promise.resolve('late'))).toMatchObject({ admitted: false })

    running.finish()
    await admitted
  })

  it('has room again once work finishes', async () => {
    const limiter = createDeliveryLimiter(unshared(1, 0))
    const running = holdWork('running')
    const admitted = limiter.run(ACME, running.work)

    expect((await limiter.run(ACME, () => Promise.resolve('refused'))).admitted).toBe(false)

    running.finish()
    await admitted

    expect(await limiter.run(ACME, () => Promise.resolve('next'))).toEqual({ admitted: true, result: 'next' })
  })

  /** A delivery that throws must not hold its slot for the life of the process. */
  it('frees the slot when the work throws, and passes the error on', async () => {
    const limiter = createDeliveryLimiter(unshared(1, 1))
    const failing = holdWork('failing')
    const waiting = holdWork('waiting')

    const failed = limiter.run(ACME, failing.work)
    const next = limiter.run(ACME, waiting.work)

    failing.fail(new Error('the row would not write'))

    await expect(failed).rejects.toThrow('the row would not write')
    await settle()

    expect(waiting.started).toBe(true)

    waiting.finish()

    expect(await next).toEqual({ admitted: true, result: 'waiting' })
  })

  /** A new arrival must not take a freed slot ahead of the work already waiting for it. */
  it('gives a freed slot to the line, not to work that arrives as it frees', async () => {
    const limiter = createDeliveryLimiter(unshared(1, 1))
    const started: string[] = []
    const running = holdWork('running')
    const admitted = [
      limiter.run(ACME, running.work),
      limiter.run(ACME, () => {
        started.push('waiting')

        return Promise.resolve('waiting')
      }),
    ]
    let late: Promise<LimitedOutcome<string>> | undefined

    running.finish()
    // Queued behind the turn that frees the slot and ahead of the turn in
    // which the waiter resumes, which is the gap a late arrival could use.
    await Promise.resolve().then(() => {
      late = limiter.run(ACME, () => {
        started.push('late')

        return Promise.resolve('late')
      })
    })
    await Promise.all(admitted)

    expect(await late).toEqual({ admitted: true, result: 'late' })
    expect(started).toEqual(['waiting', 'late'])
  })

  it('refuses limits that could never run anything, and a share above the whole', () => {
    expect(() => createDeliveryLimiter(unshared(0, 1))).toThrow(RangeError)
    expect(() => createDeliveryLimiter(unshared(1.5, 1))).toThrow(RangeError)
    expect(() => createDeliveryLimiter(unshared(1, -1))).toThrow(RangeError)
    expect(() => createDeliveryLimiter({ ...unshared(2, 2), maxConcurrentPerWorkspace: 0 })).toThrow(RangeError)
    expect(() => createDeliveryLimiter({ ...unshared(2, 2), maxConcurrentPerWorkspace: 3 })).toThrow(RangeError)
    expect(() => createDeliveryLimiter({ ...unshared(2, 2), maxWaitingPerWorkspace: 3 })).toThrow(RangeError)
  })

  /**
   * The process limits alone would let one workspace with slow endpoints hold
   * every slot and fill the line, and every other workspace's work would be
   * refused. Each workspace has a share of both.
   */
  describe('the share of one workspace', () => {
    const shared: DeliveryLimits = {
      maxConcurrent: 4,
      maxWaiting: 6,
      maxConcurrentPerWorkspace: 2,
      maxWaitingPerWorkspace: 3,
    }

    it('runs the work of another workspace while one is at its share of the slots', async () => {
      const limiter = createDeliveryLimiter(shared)
      const held = Array.from({ length: 4 }, (_, index) => holdWork(`acme-${String(index)}`))
      const acme = held.map((work) => limiter.run(ACME, work.work))
      await settle()

      // Two of the four slots, and no more, however many are free.
      expect(held.map((work) => work.started)).toEqual([true, true, false, false])

      expect(await limiter.run(OTHER, () => Promise.resolve('sent'))).toEqual({
        admitted: true,
        result: 'sent',
      })

      for (const work of held) {
        work.finish()
      }

      await Promise.all(acme)
    })

    it('refuses the work of a workspace over its share of the line, and not the work of another', async () => {
      const limiter = createDeliveryLimiter(shared)
      // Two run and three wait: the workspace's whole share.
      const held = Array.from({ length: 5 }, (_, index) => holdWork(`acme-${String(index)}`))
      const acme = held.map((work) => limiter.run(ACME, work.work))
      const over = holdWork('over')

      expect(await limiter.run(ACME, over.work)).toEqual({ admitted: false, limit: 'workspace' })
      expect(over.started).toBe(false)

      // Half the line is still free, and so are two slots.
      expect(await limiter.run(OTHER, () => Promise.resolve('sent'))).toEqual({
        admitted: true,
        result: 'sent',
      })

      for (const work of held) {
        work.finish()
      }

      expect((await Promise.all(acme)).every((outcome) => outcome.admitted)).toBe(true)
    })

    it('names the process when the whole line is full', async () => {
      const limiter = createDeliveryLimiter({
        maxConcurrent: 1,
        maxWaiting: 2,
        maxConcurrentPerWorkspace: 1,
        maxWaitingPerWorkspace: 1,
      })
      const held = [holdWork('acme-running'), holdWork('acme-waiting'), holdWork('other-waiting')]
      const admitted = [
        limiter.run(ACME, held[0]?.work ?? noWork),
        limiter.run(ACME, held[1]?.work ?? noWork),
        limiter.run(OTHER, held[2]?.work ?? noWork),
      ]

      expect(await limiter.run('ws_third', () => Promise.resolve('late'))).toEqual({
        admitted: false,
        limit: 'process',
      })

      for (const work of held) {
        work.finish()
      }

      await Promise.all(admitted)
    })

    /** A workspace's own line must not hold up the work behind it that could run. */
    it('passes over a waiter whose workspace is at its share, and keeps its place', async () => {
      const limiter = createDeliveryLimiter({
        maxConcurrent: 2,
        maxWaiting: 4,
        maxConcurrentPerWorkspace: 1,
        maxWaitingPerWorkspace: 2,
      })
      const acmeRunning = holdWork('acme-running')
      const acmeWaiting = holdWork('acme-waiting')
      const otherRunning = holdWork('other-running')
      const otherWaiting = holdWork('other-waiting')

      const outcomes = [
        limiter.run(ACME, acmeRunning.work),
        limiter.run(ACME, acmeWaiting.work),
        limiter.run(OTHER, otherRunning.work),
        limiter.run(OTHER, otherWaiting.work),
      ]
      await settle()

      expect([acmeWaiting.started, otherWaiting.started]).toEqual([false, false])

      // The slot that frees is the other workspace's. Acme's waiter is older
      // and still at its share, so the slot goes to the next in the line.
      otherRunning.finish()
      await settle()

      expect([acmeWaiting.started, otherWaiting.started]).toEqual([false, true])

      acmeRunning.finish()
      await settle()

      expect(acmeWaiting.started).toBe(true)

      acmeWaiting.finish()
      otherWaiting.finish()

      expect((await Promise.all(outcomes)).every((outcome) => outcome.admitted)).toBe(true)
    })

    it('gives a workspace its share again once its work finishes', async () => {
      const limiter = createDeliveryLimiter({
        maxConcurrent: 2,
        maxWaiting: 2,
        maxConcurrentPerWorkspace: 1,
        maxWaitingPerWorkspace: 0,
      })
      const first = holdWork('first')
      const running = limiter.run(ACME, first.work)

      expect(await limiter.run(ACME, () => Promise.resolve('refused'))).toEqual({
        admitted: false,
        limit: 'workspace',
      })

      first.finish()
      await running

      expect(await limiter.run(ACME, () => Promise.resolve('next'))).toEqual({
        admitted: true,
        result: 'next',
      })
    })
  })
})

describe('webhookLimitsConfigSchema', () => {
  const DEFAULTS = {
    WEBHOOK_MAX_PER_WORKSPACE: DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE,
    WEBHOOK_MAX_CONCURRENT_DELIVERIES: DEFAULT_MAX_CONCURRENT_DELIVERIES,
    WEBHOOK_MAX_WAITING_DELIVERIES: DEFAULT_MAX_WAITING_DELIVERIES,
    WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: DEFAULT_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE,
    WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: DEFAULT_MAX_WAITING_DELIVERIES_PER_WORKSPACE,
  }

  it('defaults when the variables are unset, and when they are blank', () => {
    expect(webhookLimitsConfigSchema.parse({})).toEqual(DEFAULTS)
    // Blank counts as absent: operators empty a line rather than delete it.
    expect(
      webhookLimitsConfigSchema.parse({
        WEBHOOK_MAX_PER_WORKSPACE: '',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '  ',
        WEBHOOK_MAX_WAITING_DELIVERIES: '',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: ' ',
        WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '',
      }),
    ).toEqual(DEFAULTS)
  })

  it('keeps the documented defaults, with a share for one workspace below the whole', () => {
    expect(DEFAULTS).toEqual({
      WEBHOOK_MAX_PER_WORKSPACE: 20,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES: 20,
      WEBHOOK_MAX_WAITING_DELIVERIES: 1_000,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: 5,
      WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: 250,
    })
  })

  it('reads whole numbers', () => {
    expect(
      webhookLimitsConfigSchema.parse({
        WEBHOOK_MAX_PER_WORKSPACE: '5',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '50',
        WEBHOOK_MAX_WAITING_DELIVERIES: '10',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '8',
        WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '0',
      }),
    ).toEqual({
      WEBHOOK_MAX_PER_WORKSPACE: 5,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES: 50,
      WEBHOOK_MAX_WAITING_DELIVERIES: 10,
      WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: 8,
      WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: 0,
    })
  })

  /** A malformed value stops boot rather than running with no limit. */
  it('refuses negatives, fractions and words, and a zero where zero means nothing can run', () => {
    for (const name of Object.keys(DEFAULTS)) {
      for (const value of ['-1', '2.5', 'many', 'NaN', 'Infinity']) {
        expect(webhookLimitsConfigSchema.safeParse({ [name]: value }).success).toBe(false)
      }
    }

    for (const name of [
      'WEBHOOK_MAX_PER_WORKSPACE',
      'WEBHOOK_MAX_CONCURRENT_DELIVERIES',
      'WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE',
    ]) {
      expect(webhookLimitsConfigSchema.safeParse({ [name]: '0' }).success).toBe(false)
    }
  })

  /** A share above the whole would be no share: one workspace could have everything. */
  it('refuses a workspace limit above its process limit, and names both', () => {
    const slots = webhookLimitsConfigSchema.safeParse({
      WEBHOOK_MAX_CONCURRENT_DELIVERIES: '10',
      WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '11',
    })
    const line = webhookLimitsConfigSchema.safeParse({
      WEBHOOK_MAX_WAITING_DELIVERIES: '300',
      WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '301',
    })

    expect(slots.success).toBe(false)
    expect(slots.error?.issues.at(0)?.path).toEqual(['WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE'])
    expect(slots.error?.issues.at(0)?.message).toContain('above WEBHOOK_MAX_CONCURRENT_DELIVERIES (10)')
    expect(line.success).toBe(false)
    expect(line.error?.issues.at(0)?.path).toEqual(['WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE'])
    expect(line.error?.issues.at(0)?.message).toContain('above WEBHOOK_MAX_WAITING_DELIVERIES (300)')
  })

  /** The default share is not lowered without a word when the process limit goes under it. */
  it('refuses a process limit set under the default share of a workspace', () => {
    expect(webhookLimitsConfigSchema.safeParse({ WEBHOOK_MAX_CONCURRENT_DELIVERIES: '3' }).success).toBe(false)
    expect(webhookLimitsConfigSchema.safeParse({ WEBHOOK_MAX_WAITING_DELIVERIES: '100' }).success).toBe(false)
    expect(
      webhookLimitsConfigSchema.safeParse({
        WEBHOOK_MAX_CONCURRENT_DELIVERIES: '3',
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '1',
      }).success,
    ).toBe(true)
  })

  /** Right for a deployment with one workspace: it may have everything. */
  it('allows a workspace limit equal to its process limit', () => {
    expect(
      webhookLimitsConfigSchema.safeParse({
        WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: '20',
        WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: '1000',
      }).success,
    ).toBe(true)
  })
})

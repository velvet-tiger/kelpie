/**
 * Bounds how many deliveries the process holds at one time.
 *
 * A slot is one delivery from its first attempt to its settled outcome, the
 * waits between attempts included. That is the unit that holds memory: the
 * body, the headers and the timers stay alive for the whole retry loop, and a
 * socket for each attempt inside it. A slot for each attempt would bound the
 * sockets and leave every delivery that is waiting to retry outside any bound.
 *
 * No clock, no database and no state outside the closure, so each engine has
 * its own and a test builds one with small numbers.
 */

export interface DeliveryLimits {
  /** How many deliveries may run at one time. At least 1. */
  readonly maxConcurrent: number
  /** How many more may wait for a slot. Zero refuses whenever every slot is in use. */
  readonly maxWaiting: number
}

/** What became of the work: it ran, or there was no room for it to wait. */
export type LimitedOutcome<Result> =
  | { readonly admitted: true; readonly result: Result }
  | { readonly admitted: false }

export interface DeliveryLimiter {
  /**
   * Runs `work` now when a slot is free, and in arrival order when one frees.
   *
   * @returns `admitted: false`, with `work` never called, when every slot is
   *   in use and the waiting line is full.
   * @throws Whatever `work` throws. The slot is freed first.
   */
  run<Result>(work: () => Promise<Result>): Promise<LimitedOutcome<Result>>
}

/**
 * @throws RangeError for limits that could never run anything, or that are not
 *   whole numbers. Unreachable through `webhookLimitsConfigSchema`, which
 *   refuses them at boot first.
 */
export function createDeliveryLimiter(limits: DeliveryLimits): DeliveryLimiter {
  if (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1) {
    throw new RangeError(`maxConcurrent must be a whole number, at least 1: ${String(limits.maxConcurrent)}`)
  }

  if (!Number.isInteger(limits.maxWaiting) || limits.maxWaiting < 0) {
    throw new RangeError(`maxWaiting must be a whole number, at least 0: ${String(limits.maxWaiting)}`)
  }

  let running = 0
  const waiting: (() => void)[] = []

  function release(): void {
    const next = waiting.shift()

    if (next === undefined) {
      running -= 1

      return
    }

    // The slot passes to the head of the line without being freed, so
    // `running` does not move. Freeing it would let a caller that arrives
    // before the waiter resumes take the slot out of turn.
    next()
  }

  return {
    async run(work) {
      if (running < limits.maxConcurrent) {
        running += 1
      } else if (waiting.length < limits.maxWaiting) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
        })
      } else {
        return { admitted: false }
      }

      try {
        return { admitted: true, result: await work() }
      } finally {
        release()
      }
    },
  }
}

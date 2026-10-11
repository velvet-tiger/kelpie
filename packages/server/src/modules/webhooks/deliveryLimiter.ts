/**
 * Bounds how many deliveries the process holds at one time, and how many of
 * them one workspace may have.
 *
 * A slot is one delivery from its first attempt to its settled outcome, the
 * waits between attempts included. That is the unit that holds memory: the
 * body, the headers and the timers stay alive for the whole retry loop, and a
 * socket for each attempt inside it. A slot for each attempt would bound the
 * sockets and leave every delivery that is waiting to retry outside any bound.
 *
 * The process limits alone would let one workspace with slow endpoints and
 * many events hold every slot and fill the line, and every other workspace's
 * deliveries would be refused. So each workspace has its own smaller share of
 * the slots and of the line.
 *
 * No clock, no database and no state outside the closure, so each engine has
 * its own and a test builds one with small numbers.
 */

export interface DeliveryLimits {
  /** How many deliveries may run at one time. At least 1. */
  readonly maxConcurrent: number
  /** How many more may wait for a slot. Zero refuses whenever no slot is free. */
  readonly maxWaiting: number
  /** How many of the running deliveries one workspace may have. From 1 to `maxConcurrent`. */
  readonly maxConcurrentPerWorkspace: number
  /** How many of the waiting deliveries one workspace may have. From 0 to `maxWaiting`. */
  readonly maxWaitingPerWorkspace: number
}

/** Whose limit left no room: the workspace's own share of the line, or the whole line. */
export type RefusingLimit = 'workspace' | 'process'

/** What became of the work: it ran, or there was no room for it to wait. */
export type LimitedOutcome<Result> =
  | { readonly admitted: true; readonly result: Result }
  | { readonly admitted: false; readonly limit: RefusingLimit }

export interface DeliveryLimiter {
  /**
   * Runs `work` now when the process and the workspace both have a free slot.
   * If not, it waits, and runs in arrival order among the work whose workspace
   * has a free slot.
   *
   * @returns `admitted: false`, with `work` never called, when the workspace's
   *   share of the line is full or the whole line is.
   * @throws Whatever `work` throws. The slot is freed first.
   */
  run<Result>(workspaceId: string, work: () => Promise<Result>): Promise<LimitedOutcome<Result>>
}

interface Waiter {
  readonly workspaceId: string
  readonly start: () => void
}

function requireWholeNumber(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a whole number from ${String(minimum)} to ${String(maximum)}: ${String(value)}`,
    )
  }
}

/**
 * @throws RangeError for limits that could never run anything, that are not
 *   whole numbers, or that give one workspace more than the process has.
 *   Unreachable through `webhookLimitsConfigSchema`, which refuses them at
 *   boot first.
 */
export function createDeliveryLimiter(limits: DeliveryLimits): DeliveryLimiter {
  requireWholeNumber('maxConcurrent', limits.maxConcurrent, 1, Number.MAX_SAFE_INTEGER)
  requireWholeNumber('maxWaiting', limits.maxWaiting, 0, Number.MAX_SAFE_INTEGER)
  requireWholeNumber('maxConcurrentPerWorkspace', limits.maxConcurrentPerWorkspace, 1, limits.maxConcurrent)
  requireWholeNumber('maxWaitingPerWorkspace', limits.maxWaitingPerWorkspace, 0, limits.maxWaiting)

  let running = 0
  const runningBy = new Map<string, number>()
  const waitingBy = new Map<string, number>()
  /** Arrival order, across every workspace. */
  const line: Waiter[] = []

  /** A workspace with no entry has none: an entry at zero is removed, so the maps stay as small as the work in hand. */
  function countOf(counts: ReadonlyMap<string, number>, workspaceId: string): number {
    return counts.get(workspaceId) ?? 0
  }

  function adjust(counts: Map<string, number>, workspaceId: string, by: number): void {
    const next = countOf(counts, workspaceId) + by

    if (next === 0) {
      counts.delete(workspaceId)
    } else {
      counts.set(workspaceId, next)
    }
  }

  function hasFreeSlot(workspaceId: string): boolean {
    return (
      running < limits.maxConcurrent &&
      countOf(runningBy, workspaceId) < limits.maxConcurrentPerWorkspace
    )
  }

  function takeSlot(workspaceId: string): void {
    running += 1
    adjust(runningBy, workspaceId, 1)
  }

  /**
   * Starts every waiter that now has a slot, oldest first.
   *
   * The waiter's slot is taken here, before it resumes. Freeing the slot and
   * letting the waiter take it later would let a caller that arrives in
   * between take it out of turn.
   *
   * A waiter whose workspace is at its share is passed over and keeps its
   * place, so one workspace's line never holds up another's.
   */
  function startWaiters(): void {
    let index = 0

    while (running < limits.maxConcurrent && index < line.length) {
      const waiter = line[index]

      if (waiter !== undefined && hasFreeSlot(waiter.workspaceId)) {
        line.splice(index, 1)
        adjust(waitingBy, waiter.workspaceId, -1)
        takeSlot(waiter.workspaceId)
        waiter.start()
      } else {
        index += 1
      }
    }
  }

  function release(workspaceId: string): void {
    running -= 1
    adjust(runningBy, workspaceId, -1)
    startWaiters()
  }

  return {
    async run(workspaceId, work) {
      if (hasFreeSlot(workspaceId)) {
        takeSlot(workspaceId)
      } else if (countOf(waitingBy, workspaceId) >= limits.maxWaitingPerWorkspace) {
        return { admitted: false, limit: 'workspace' }
      } else if (line.length >= limits.maxWaiting) {
        return { admitted: false, limit: 'process' }
      } else {
        adjust(waitingBy, workspaceId, 1)

        await new Promise<void>((resolve) => {
          line.push({ workspaceId, start: resolve })
        })
      }

      try {
        return { admitted: true, result: await work() }
      } finally {
        release(workspaceId)
      }
    },
  }
}

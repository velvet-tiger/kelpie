/**
 * Helpers for outbound work that a job may stop.
 *
 * A job's `signal` fires when the queue counts the job as expired. pg-boss
 * then frees the job's slot and may run a retry, but it cannot stop the
 * handler. Work that keeps going after that runs outside the queue's limits,
 * beside its own retry. These let a sender stop when the signal fires.
 */

/**
 * The signal for one outbound attempt: it fires after `timeoutMs`, or when
 * `jobSignal` fires, whichever is first.
 */
export function attemptSignal(timeoutMs: number, jobSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)

  return jobSignal === undefined ? timeout : AbortSignal.any([timeout, jobSignal])
}

/**
 * Waits for `work`, or rejects with the signal's reason when it fires first.
 *
 * For work that takes no signal of its own, such as the egress guard's DNS
 * check. The work is not stopped, only no longer waited for: a lookup that
 * hangs holds nothing of the job's. Its own outcome is then dropped on
 * purpose, so it cannot surface later as an unhandled rejection.
 */
export function untilAborted<Result>(work: Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) {
    work.catch(() => undefined)

    return Promise.reject(signal.reason)
  }

  return new Promise<Result>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

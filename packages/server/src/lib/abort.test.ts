import { describe, expect, it } from 'vitest'

import { attemptSignal, untilAborted } from './abort.ts'

describe('attemptSignal', () => {
  it('fires when the job signal fires, before the timeout', () => {
    const job = new AbortController()
    const signal = attemptSignal(60_000, job.signal)

    expect(signal.aborted).toBe(false)
    job.abort(new Error('expired'))
    expect(signal.aborted).toBe(true)
  })

  it('fires on the timeout with no job signal', async () => {
    const signal = attemptSignal(10)

    await expect.poll(() => signal.aborted).toBe(true)
  })
})

describe('untilAborted', () => {
  it('answers what the work answers', async () => {
    await expect(untilAborted(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7)
    await expect(untilAborted(Promise.reject(new Error('no')), new AbortController().signal)).rejects.toThrow('no')
  })

  it('stops waiting on work that never ends when the signal fires', async () => {
    const controller = new AbortController()
    const waiting = untilAborted(new Promise<never>(() => undefined), controller.signal)

    controller.abort(new Error('expired'))

    await expect(waiting).rejects.toThrow('expired')
  })

  it('rejects at once for a signal that has already fired', async () => {
    const controller = new AbortController()

    controller.abort(new Error('expired'))

    await expect(untilAborted(Promise.resolve(1), controller.signal)).rejects.toThrow('expired')
  })
})

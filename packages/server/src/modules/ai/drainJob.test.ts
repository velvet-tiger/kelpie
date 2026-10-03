import { describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { AI_DRAIN_JOB_NAME, defineAiDrainJob } from './drainJob.ts'
import type { AiRunNextOutcome } from './executor.ts'

/**
 * The `ai.drain` handler without a queue: what it asks the executor, and when
 * it asks for another job. `ai.test.ts` covers the same job on a real worker.
 */

const log = createLogger({ level: 'error', transports: [createCaptureTransport(() => undefined)] })

async function runWith(outcome: AiRunNextOutcome): Promise<{ readonly ranFor: string[]; readonly enqueued: string[] }> {
  const ranFor: string[] = []
  const enqueued: string[] = []
  const definition = defineAiDrainJob({
    executor: {
      runNext: (workspaceId) => {
        ranFor.push(workspaceId)
        return Promise.resolve(outcome)
      },
    },
    enqueueNext: (workspaceId) => {
      enqueued.push(workspaceId)
      return Promise.resolve()
    },
    runTimeoutMinutes: 15,
    concurrency: 4,
  })

  await definition.handler({
    id: 'job_1',
    data: { workspaceId: 'wsp_1' },
    log,
    signal: new AbortController().signal,
  })

  return { ranFor, enqueued }
}

describe('ai.drain', () => {
  it('is never retried, expires with the run timeout, and caps the process', () => {
    const definition = defineAiDrainJob({
      executor: { runNext: () => Promise.resolve('idle') },
      enqueueNext: () => Promise.resolve(),
      runTimeoutMinutes: 15,
      concurrency: 4,
    })

    expect(definition.name).toBe(AI_DRAIN_JOB_NAME)
    expect(definition.defaults).toEqual({ retryLimit: 0, expireInSeconds: 900, localConcurrency: 4 })
  })

  it('asks for the next job when a run settled and another is waiting', async () => {
    expect(await runWith('ran_more_queued')).toEqual({ ranFor: ['wsp_1'], enqueued: ['wsp_1'] })
  })

  it.each<AiRunNextOutcome>(['ran', 'at_capacity', 'idle'])('asks for nothing more after %s', async (outcome) => {
    expect(await runWith(outcome)).toEqual({ ranFor: ['wsp_1'], enqueued: [] })
  })

  it('refuses a payload with no workspace', () => {
    const definition = defineAiDrainJob({
      executor: { runNext: () => Promise.resolve('idle') },
      enqueueNext: () => Promise.resolve(),
      runTimeoutMinutes: 15,
      concurrency: 4,
    })

    expect(definition.schema.safeParse({}).success).toBe(false)
    expect(definition.schema.safeParse({ workspaceId: '' }).success).toBe(false)
  })
})

import { z } from 'zod'

import type { JobDefinition } from '../../lib/jobs.ts'
import type { AiExecutor } from './executor.ts'

/**
 * The background job that runs queued AI runs.
 *
 * Intake enqueues one in the same transaction that records the run, so a run
 * that is saved always has a job to start it. The handler runs one run and,
 * when another is waiting, asks for the next job. Model calls therefore
 * happen on whichever process works the queue: the worker entry point, or the
 * API when it runs its own worker (the open-source default).
 *
 * Never retried. A repeated model call re-applies its operations, so a job
 * that fails or expires stays failed and goes to `ai.drain.dead`; the run row
 * is settled by the executor, or by the stale sweep if the process died.
 */

export const AI_DRAIN_JOB_NAME = 'ai.drain'

const aiDrainJobDataSchema = z.object({ workspaceId: z.string().min(1) })

export type AiDrainJobData = z.infer<typeof aiDrainJobDataSchema>

export interface AiDrainJobDependencies {
  readonly executor: AiExecutor
  /** Enqueues the next `ai.drain` job for a workspace, in its own transaction. */
  readonly enqueueNext: (workspaceId: string) => Promise<void>
  /** `AI_RUN_TIMEOUT_MINUTES`. A job runs one run, so it shares the run's limit. */
  readonly runTimeoutMinutes: number
  /** `AI_WORKER_CONCURRENCY`: runs one process executes at once, across workspaces. */
  readonly concurrency: number
}

export function defineAiDrainJob(dependencies: AiDrainJobDependencies): JobDefinition<AiDrainJobData> {
  return {
    name: AI_DRAIN_JOB_NAME,
    schema: aiDrainJobDataSchema,
    defaults: {
      retryLimit: 0,
      expireInSeconds: dependencies.runTimeoutMinutes * 60,
      localConcurrency: dependencies.concurrency,
    },
    async handler({ data }) {
      const outcome = await dependencies.executor.runNext(data.workspaceId)

      if (outcome === 'ran_more_queued') {
        await dependencies.enqueueNext(data.workspaceId)
      }
    },
  }
}

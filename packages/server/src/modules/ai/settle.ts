import type { TransactionScope } from '../../runtime/transaction.ts'
import type { AiRunSettledData } from './events.ts'
import { settleRun, sweepStaleRuns } from './repository.ts'
import type { AiRunRecord, SettleRunInput } from './repository.ts'

/**
 * Settles runs and reports each one as `ai.run.settled`.
 *
 * Every path that ends a run goes through here, so a subscriber sees every
 * settled run exactly as the row records it. The update and the emit share one
 * transaction: the event fires after the commit, and not at all on a rollback.
 */
export interface AiRunSettler {
  settle(workspaceId: string, runId: string, changes: SettleRunInput): Promise<void>
  /** Fails the workspace's `running` rows last touched before `before`. Returns how many. */
  sweepStale(workspaceId: string, before: Date, reason: string): Promise<number>
}

export interface AiRunSettlerDependencies {
  readonly transaction: TransactionScope
  readonly now: () => Date
}

export function createAiRunSettler(dependencies: AiRunSettlerDependencies): AiRunSettler {
  return {
    async settle(workspaceId, runId, changes) {
      await dependencies.transaction(
        async ({ tx, events }) => {
          const settled = await settleRun(tx, runId, changes, dependencies.now())
          if (settled !== undefined) {
            events.emit('ai.run.settled', { type: 'ai_run', id: settled.id }, settledData(settled))
          }
        },
        { workspaceId },
      )
    },

    async sweepStale(workspaceId, before, reason) {
      return dependencies.transaction(
        async ({ tx, events }) => {
          const swept = await sweepStaleRuns(tx, workspaceId, before, dependencies.now(), reason)
          for (const run of swept) {
            events.emit('ai.run.settled', { type: 'ai_run', id: run.id }, settledData(run))
          }
          return swept.length
        },
        { workspaceId },
      )
    },
  }
}

function settledData(run: AiRunRecord): AiRunSettledData {
  if (run.status !== 'succeeded' && run.status !== 'failed') {
    // Throwing rolls the settle back, so the row stays in flight for the sweep.
    throw new Error(`ai run ${run.id} was settled as "${run.status}"; only succeeded and failed end a run`)
  }

  return {
    runId: run.id,
    // A synchronous run, such as person intake, stores its own id as
    // `agent_run_id` because the column is a non-null dedupe key. No core
    // agent run stands behind it, so it reports null.
    agentRunId: run.agentRunId === run.id ? null : run.agentRunId,
    taskId: run.taskId,
    status: run.status,
    model: run.model,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    modelRequests: run.modelRequests,
    webSearches: run.webSearches,
    createdAt: run.createdAt.toISOString(),
    settledAt: run.updatedAt.toISOString(),
  }
}

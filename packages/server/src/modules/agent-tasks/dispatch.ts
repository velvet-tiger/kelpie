import type { Database } from '../../lib/database.ts'
import { describeThrown } from '../../lib/errors.ts'
import type { Logger } from '../../lib/logger.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import * as repository from './repository.ts'
import type { AgentRecord, RunRecord } from './repository.ts'
import { dispatchPayload } from './wire.ts'
import type { ResolvedTaskView } from './wire.ts'

/**
 * The dispatch engine: one run, one POST to the registered agent's endpoint.
 *
 * It runs detached from the request that created the run, so a slow or
 * unreachable agent slows nobody down; the caller polls the run instead.
 *
 * One attempt, deliberately, where webhook delivery retries three times. A
 * webhook receiver dedupes on the delivery id and a repeated event is cheap;
 * an agent that accepted a task and then timed out on the response would run
 * the whole task twice if Kelpie re-POSTed it. A failed run keeps its reason
 * and the human re-runs it from the page.
 */

/** How long the agent has to accept the dispatch before it counts as failed. */
export const DISPATCH_TIMEOUT_MS = 10_000

export interface DispatchRequest {
  readonly url: string
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

export interface DispatchOutcome {
  readonly delivered: boolean
  /** The response status, or null when no response arrived at all. */
  readonly status: number | null
  /** Why it failed, for the run log. Null on success. */
  readonly reason: string | null
}

/** The outbound port. Injected so no test makes a network call. */
export type SendDispatch = (request: DispatchRequest) => Promise<DispatchOutcome>

/**
 * The real sender. Redirects are not followed, the webhook rule: an endpoint
 * that moved should be seen and corrected rather than have a workspace's
 * prompt posted wherever the old address now points.
 *
 * The catch is broad because this is the process boundary: `fetch` rejects
 * with anything from a DNS failure to an abort, and turning all of it into one
 * outcome is the port's whole job. Nothing is swallowed — the reason lands on
 * the run.
 */
export function createHttpSender(fetchImplementation: typeof fetch = fetch): SendDispatch {
  return async (request) => {
    try {
      const response = await fetchImplementation(request.url, {
        method: 'POST',
        body: request.body,
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      })

      return response.ok
        ? { delivered: true, status: response.status, reason: null }
        : {
            delivered: false,
            status: response.status,
            reason: `agent endpoint answered ${String(response.status)}`,
          }
    } catch (error: unknown) {
      return { delivered: false, status: null, reason: describeThrown(error) }
    }
  }
}

export interface DispatchDependencies {
  readonly db: Database
  readonly now: () => Date
  readonly cipher: SecretCipher
  readonly send: SendDispatch
  readonly log: Logger
}

export interface DispatchEngine {
  /**
   * Moves the run `queued → running → succeeded | failed`. Total: every
   * failure path settles the run rather than rejecting, so a caller may fire
   * it without awaiting.
   */
  dispatch(run: RunRecord, agent: AgentRecord, resolved: ResolvedTaskView): Promise<void>
}

export function createDispatchEngine(dependencies: DispatchDependencies): DispatchEngine {
  async function settle(runId: string, outcome: DispatchOutcome): Promise<void> {
    await repository.updateRun(dependencies.db, runId, {
      status: outcome.delivered ? 'succeeded' : 'failed',
      failureReason: outcome.reason,
      updatedAt: dependencies.now(),
    })
  }

  return {
    async dispatch(run, agent, resolved) {
      try {
        await repository.updateRun(dependencies.db, run.id, {
          status: 'running',
          updatedAt: dependencies.now(),
        })

        let authHeader: string | undefined

        if (agent.authHeaderEncrypted !== null) {
          try {
            authHeader = dependencies.cipher.open(agent.authHeaderEncrypted)
          } catch (error: unknown) {
            if (!(error instanceof SecretDecryptionError)) {
              throw error
            }

            // The fault is Kelpie's key, not the agent's endpoint. The run
            // still fails — the dispatch cannot happen — but the reason points
            // at the key so nobody debugs a healthy agent.
            dependencies.log.error('agent auth header could not be decrypted', {
              agentId: agent.id,
              runId: run.id,
              error: describeThrown(error),
            })
            await settle(run.id, {
              delivered: false,
              status: null,
              reason:
                'The stored auth header could not be decrypted; check SECRET_ENCRYPTION_KEY, then save the header again',
            })

            return
          }
        }

        const outcome = await dependencies.send({
          url: agent.endpoint,
          body: JSON.stringify(dispatchPayload(run, resolved)),
          headers: {
            'content-type': 'application/json',
            ...(authHeader === undefined ? {} : { authorization: authHeader }),
          },
        })

        if (!outcome.delivered) {
          dependencies.log.warn('agent dispatch failed', {
            agentId: agent.id,
            runId: run.id,
            taskId: run.taskId,
            status: outcome.status,
            reason: outcome.reason,
          })
        }

        await settle(run.id, outcome)
      } catch (error: unknown) {
        // The engine's own boundary: `dispatch` promises to settle rather than
        // reject, because nothing awaits it. Whatever slipped past the paths
        // above still lands on the run.
        dependencies.log.error('agent dispatch could not be attempted', {
          agentId: agent.id,
          runId: run.id,
          error: describeThrown(error),
        })

        try {
          await settle(run.id, {
            delivered: false,
            status: null,
            reason: describeThrown(error),
          })
        } catch (settleError: unknown) {
          // The settle write itself failed — likely the database. The run is
          // left `running` and there is nothing sound to write anywhere.
          dependencies.log.error('agent run could not be settled', {
            runId: run.id,
            error: describeThrown(settleError),
          })
        }
      }
    },
  }
}

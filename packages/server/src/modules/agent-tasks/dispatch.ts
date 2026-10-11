import type { Database } from '../../lib/database.ts'
import { BlockedEgressError } from '../../lib/egress.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { describeThrown } from '../../lib/errors.ts'
import type { Logger } from '../../lib/logger.ts'
import type { AgentDispatchOutcome, AgentDispatcher } from '../../runtime/module.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
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

/** The same shape as the runtime's, so an in-process dispatcher's answer lands on the run unchanged. */
export type DispatchOutcome = AgentDispatchOutcome

/**
 * What the sender answers: the outcome for the run, and what only the server
 * log may hold. `reason` is stored on the run, where every member of the
 * workspace reads it, so an address that a host resolved to never goes in it.
 */
export interface SendOutcome extends DispatchOutcome {
  /** The address the egress guard refused. Absent on every other outcome. */
  readonly blockedAddress?: string
}

/** The outbound port. Injected so no test makes a network call. */
export type SendDispatch = (request: DispatchRequest) => Promise<SendOutcome>

/**
 * The real sender. Redirects are not followed, the webhook rule: an endpoint
 * that moved should be seen and corrected rather than have a workspace's
 * prompt posted wherever the old address now points.
 *
 * The catch is broad because this is the process boundary: `fetch` rejects
 * with anything from a DNS failure to an abort, and turning all of it into one
 * outcome is the port's whole job. Nothing is swallowed — the reason lands on
 * the run. A blocked private address (`egress.check`, or the guard's `fetch`
 * at the connection) reaches the same catch and lands on the run the same
 * way, with the address beside the reason for the log.
 */
export function createHttpSender(
  egress: EgressGuard,
  fetchImplementation: typeof fetch = egress.fetch,
): SendDispatch {
  return async (request) => {
    try {
      await egress.check(request.url)

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
      const failed = { delivered: false, status: null, reason: describeThrown(error) }

      return error instanceof BlockedEgressError ? { ...failed, blockedAddress: error.address } : failed
    }
  }
}

export interface DispatchDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly now: () => Date
  readonly cipher: SecretCipher
  readonly send: SendDispatch
  /**
   * The in-process dispatcher for a `managed_by` value. A row a module manages
   * never goes over HTTP: its module receives the payload directly.
   */
  readonly findManagedDispatcher: (managedBy: string) => AgentDispatcher | undefined
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
  /**
   * Ends the run and reports it as `agent_tasks.run.settled`. Every path that
   * ends a run goes through here. The update and the emit share one
   * transaction: the event fires after the commit, and not at all on a
   * rollback or for a run that had already ended.
   */
  async function settle(run: RunRecord, agent: AgentRecord, outcome: DispatchOutcome): Promise<void> {
    const status = outcome.delivered ? 'succeeded' : 'failed'

    await dependencies.transaction(
      async ({ tx, events }) => {
        const settled = await repository.settleRun(tx, run.id, {
          status,
          failureReason: outcome.reason,
          updatedAt: dependencies.now(),
        })

        if (settled !== undefined) {
          events.emit(
            'agent_tasks.run.settled',
            { type: 'agent_run', id: settled.id },
            {
              runId: settled.id,
              taskId: settled.taskId,
              agentId: settled.agentId,
              managedBy: agent.managedBy,
              status,
            },
          )
        }
      },
      { workspaceId: run.workspaceId },
    )
  }

  /**
   * A module-managed row: hand the payload to the module that manages it. The
   * row's endpoint and auth header are not read. When no module in this
   * assembly provides the dispatcher (the module was removed from the list),
   * the run fails and says which module is missing.
   */
  async function dispatchInProcess(
    run: RunRecord,
    agent: AgentRecord,
    managedBy: string,
    resolved: ResolvedTaskView,
  ): Promise<void> {
    const dispatcher = dependencies.findManagedDispatcher(managedBy)

    const outcome: DispatchOutcome =
      dispatcher === undefined
        ? {
            delivered: false,
            status: null,
            reason: `This agent is run by the "${managedBy}" module, which this deployment does not include`,
          }
        : await dispatcher(dispatchPayload(run, resolved))

    if (!outcome.delivered) {
      dependencies.log.warn('agent dispatch failed', {
        agentId: agent.id,
        runId: run.id,
        taskId: run.taskId,
        managedBy,
        status: outcome.status,
        reason: outcome.reason,
      })
    }

    await settle(run, agent, outcome)
  }

  return {
    async dispatch(run, agent, resolved) {
      try {
        await repository.updateRun(dependencies.db, run.id, {
          status: 'running',
          updatedAt: dependencies.now(),
        })

        if (agent.managedBy !== null) {
          await dispatchInProcess(run, agent, agent.managedBy, resolved)
          return
        }

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
            await settle(run, agent, {
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
            ...(outcome.blockedAddress === undefined ? {} : { blockedAddress: outcome.blockedAddress }),
          })
        }

        await settle(run, agent, outcome)
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
          await settle(run, agent, {
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

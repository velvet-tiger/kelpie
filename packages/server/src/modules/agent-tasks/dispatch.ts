import { AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import { attemptSignal, untilAborted } from '../../lib/abort.ts'
import type { Database } from '../../lib/database.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { describeThrown } from '../../lib/errors.ts'
import type { JobDefinition } from '../../lib/jobs.ts'
import type { Logger } from '../../lib/logger.ts'
import { describeOutboundFailure } from '../../lib/outbound.ts'
import type { AgentDispatchOutcome, AgentDispatcher } from '../../runtime/module.ts'
import { SecretDecryptionError } from '../../lib/secrets.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { findTask } from './catalog.ts'
import * as repository from './repository.ts'
import type { AgentRecord, RunRecord } from './repository.ts'
import { buildTaskView } from './view.ts'
import { dispatchPayload } from './wire.ts'
import type { ResolvedTaskView } from './wire.ts'

/**
 * The dispatch engine: one run, one POST to the registered agent's endpoint.
 *
 * Running a task inserts the run and enqueues one `agent-tasks.dispatch` job
 * in the same transaction (`service.ts`). A rolled-back run leaves no job,
 * and a crash after the commit leaves a job rather than a run stuck at
 * `queued`. The caller polls the run.
 *
 * The job carries the workspace and run ids only. When it runs, it reads the
 * run, the agent and the target again and builds the prompt then: the prompt
 * holds CRM data, which does not belong in `pgboss.job`, and a run that
 * waited reads the record as it is when it goes.
 *
 * One attempt, deliberately, where webhook delivery retries three times. A
 * webhook receiver dedupes on the delivery id and a repeated event is cheap;
 * an agent that accepted a task and then timed out on the response would run
 * the whole task twice if Kelpie re-POSTed it. So the job has no retry, and
 * the run moves `queued → running` in one conditional write before anything
 * is sent: a job that runs a second time finds the run no longer `queued`
 * and sends nothing. A failed run keeps its reason and the human re-runs it
 * from the page.
 *
 * A job whose worker stopped before the run settled ends in the dead-letter
 * queue, and `failAbandonedRun` fails the run there. A job that expires is
 * stopped by its signal, so its POST does not go on beside the dead-letter
 * handler; a dispatch that settles after that finds the run ended and says so
 * in the log.
 *
 * The jobs of one workspace are one pg-boss group. Most runs come from a
 * person who clicks Run, but an API key can start many, and the group limit
 * keeps one workspace's runs from holding every worker.
 */

export const DISPATCH_AGENT_RUN_JOB = 'agent-tasks.dispatch'

/** How long the agent has to accept the dispatch before it counts as failed. */
export const DISPATCH_TIMEOUT_MS = 10_000

/**
 * When the queue counts a running dispatch as lost: the resolve reads, the
 * 10 s accept timeout, and the settle write, with room to spare. An
 * in-process dispatcher has no timeout of its own and is asked to answer at
 * once (`AgentDispatcher`); one that takes longer than this has its run
 * failed by the dead-letter handler.
 */
export const DISPATCH_EXPIRE_SECONDS = 60

/**
 * Dispatches one worker process runs at the same time, and the most one
 * workspace may hold across all processes.
 *
 * A dispatch is one POST that the agent must accept within 10 s, so 5 per
 * process, the runtime's default, is plenty for runs that people start. A
 * group limit of 2 leaves 3 of the 5 slots of one worker for other
 * workspaces while one workspace has a burst of runs from a script, and
 * still lets that workspace dispatch two at a time. It must stay below the
 * local concurrency, or one workspace can fill a worker.
 */
export const DISPATCH_LOCAL_CONCURRENCY = 5
export const DISPATCH_GROUP_CONCURRENCY = 2

/**
 * The ids of the run to dispatch, and the target type the run was allowed
 * for. Never the prompt or the record.
 *
 * The target type is fixed here at enqueue. A conversion moves a run to the
 * new record (`conversions/repoint.ts`), which can be of another type, and
 * the scopes a caller needed to run a task depend on the type. A run whose
 * type changed is failed, not sent against a type nobody was checked for.
 */
export const dispatchJobDataSchema = z
  .object({
    workspaceId: z.string().min(1),
    runId: z.string().min(1),
    targetType: z.enum(AGENT_TASK_TARGET_TYPES),
  })
  .strict()

export type DispatchJobData = z.infer<typeof dispatchJobDataSchema>

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
  /** True when the deployment's DNS resolver did not answer. Server log only. */
  readonly kelpieFault?: boolean
  /** The whole cause of a failure, addresses included. Server log only. */
  readonly logDetail?: string
}

/**
 * The outbound port. Injected so no test makes a network call.
 *
 * @param signal The job's signal. It fires when the queue counts the job as
 *   expired, and the POST must stop then.
 */
export type SendDispatch = (request: DispatchRequest, signal?: AbortSignal) => Promise<SendOutcome>

/**
 * Lets go of a response body nobody reads, so its connection goes back to the
 * pool rather than waiting for the garbage collector.
 *
 * Not awaited, and a refusal is dropped on purpose: the status is all the
 * dispatch needed, a body that fails to close changes no outcome, and the
 * dispatch must not wait on an endpoint that keeps sending.
 */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

/**
 * The real sender. Redirects are not followed, the webhook rule: an endpoint
 * that moved should be seen and corrected rather than have a workspace's
 * prompt posted wherever the old address now points.
 *
 * The catch is broad because this is the process boundary: `fetch` rejects
 * with anything from a DNS failure to an abort, and turning all of it into one
 * outcome is the port's whole job. Nothing is swallowed — the reason lands on
 * the run, naming a network fault by its code and never by an address
 * (`describeOutboundFailure`). A blocked private address (`egress.check`, or
 * the guard's `fetch` at the connection) reaches the same catch and lands on
 * the run the same way, with the address beside the reason for the log only.
 *
 * One signal bounds the whole POST: the accept timeout, or the job's own
 * signal when the queue expires the job. The egress check takes no signal,
 * so the POST stops waiting for it when the signal fires.
 */
export function createHttpSender(
  egress: EgressGuard,
  fetchImplementation: typeof fetch = egress.fetch,
): SendDispatch {
  return async (request, jobSignal) => {
    const signal = attemptSignal(DISPATCH_TIMEOUT_MS, jobSignal)

    try {
      await untilAborted(egress.check(request.url), signal)

      const response = await fetchImplementation(request.url, {
        method: 'POST',
        body: request.body,
        headers: request.headers,
        redirect: 'manual',
        signal,
      })

      discardBody(response)

      return response.ok
        ? { delivered: true, status: response.status, reason: null }
        : {
            delivered: false,
            status: response.status,
            reason: `agent endpoint answered ${String(response.status)}`,
          }
    } catch (error: unknown) {
      return { delivered: false, status: null, ...describeOutboundFailure(error) }
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

/**
 * The reason on a run whose agent was removed after the run was made.
 *
 * Rarely seen: `agent_runs.agent_id` cascades, so deleting an agent deletes
 * its runs, and the job then finds no run. It is reachable only when the
 * delete lands between the job's read of the run and its read of the agent,
 * and then the settle finds no run either. Kept so that window ends in a
 * reason rather than a crash.
 */
export const AGENT_GONE_REASON = 'The agent was removed before the task ran'
/** The reason on a run whose task this deployment no longer has. */
export const TASK_GONE_REASON = 'This task is not in this deployment any more'
/** The reason on a run whose target was converted to a record of another type after the run was made. */
export const TARGET_CONVERTED_REASON =
  'The record this task was run on was converted to another kind of record before the task ran. Run the task again on the new record'
/** The reason on a run whose target was deleted after the run was made. */
export const TARGET_GONE_REASON = 'The record this task was run on was deleted before the task ran'
/** The reason on a run whose dispatch never finished. */
export const ABANDONED_RUN_REASON = 'The dispatch did not finish. Run the task again'

export interface DispatchEngine {
  /**
   * The job's handler: reads the run, its agent and its target again, and
   * dispatches it. Does nothing for a run that is no longer `queued`.
   */
  dispatchRun(data: DispatchJobData, log: Logger, signal?: AbortSignal): Promise<void>
  /**
   * Moves the run `queued → running → succeeded | failed`. Sends nothing when
   * the run is no longer `queued`. Every failure of the send settles the run.
   *
   * @param signal The job's signal, handed to the HTTP sender. An in-process
   *   dispatcher takes none: `AgentDispatcher` is public, and it is asked to
   *   answer at once.
   * @throws Error when the run could not be settled at all, so the job ends
   *   in the dead-letter queue and `failAbandonedRun` tries again.
   */
  dispatch(run: RunRecord, agent: AgentRecord, resolved: ResolvedTaskView, signal?: AbortSignal): Promise<void>
  /**
   * The dead-letter handler: fails a run still `queued` or `running`. Safe to
   * run more than once, since a run that has ended is not changed.
   */
  failAbandonedRun(data: DispatchJobData, log: Logger): Promise<void>
}

/** What the job found when it read the run's agent, task and target again. */
type Preparation =
  | { readonly kind: 'ready'; readonly agent: AgentRecord; readonly resolved: ResolvedTaskView }
  | { readonly kind: 'gone'; readonly reason: string; readonly managedBy: string | null }

export function createDispatchEngine(dependencies: DispatchDependencies): DispatchEngine {
  /**
   * Ends the run and reports it as `agent_tasks.run.settled`. Every path that
   * ends a run goes through here. The update and the emit share one
   * transaction: the event fires after the commit, and not at all on a
   * rollback or for a run that had already ended.
   *
   * @returns False when there was nothing to end: the run had already ended,
   *   or it went with its agent.
   */
  async function settle(run: RunRecord, managedBy: string | null, outcome: DispatchOutcome): Promise<boolean> {
    const status = outcome.delivered ? 'succeeded' : 'failed'

    return dependencies.transaction(
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
            { runId: settled.id, taskId: settled.taskId, agentId: settled.agentId, managedBy, status },
          )
        }

        return settled !== undefined
      },
      { workspaceId: run.workspaceId },
    )
  }

  function failed(reason: string): DispatchOutcome {
    return { delivered: false, status: null, reason }
  }

  /**
   * Reads what the run needs again, as it is now.
   *
   * @param authorisedType The target type the run was allowed for, from the job.
   */
  async function prepare(run: RunRecord, authorisedType: string): Promise<Preparation> {
    const agent = await repository.findAgent(dependencies.db, run.workspaceId, run.agentId)

    // See `AGENT_GONE_REASON`: a race with a delete of the agent.
    if (agent === undefined) {
      return { kind: 'gone', reason: AGENT_GONE_REASON, managedBy: null }
    }

    if (run.targetType !== authorisedType) {
      return { kind: 'gone', reason: TARGET_CONVERTED_REASON, managedBy: agent.managedBy }
    }

    const definition = findTask(run.taskId)
    const targetType = definition?.targetTypes.find((type) => type === run.targetType)

    if (definition === undefined || targetType === undefined) {
      return { kind: 'gone', reason: TASK_GONE_REASON, managedBy: agent.managedBy }
    }

    const resolved = await buildTaskView(dependencies.db, run.workspaceId, definition, {
      targetType,
      targetId: run.targetId,
    })

    return resolved === undefined
      ? { kind: 'gone', reason: TARGET_GONE_REASON, managedBy: agent.managedBy }
      : { kind: 'ready', agent, resolved }
  }

  /**
   * A module-managed row: hand the payload to the module that manages it. The
   * row's endpoint and auth header are not read. When no module in this
   * assembly provides the dispatcher (the module was removed from the list),
   * the run fails and says which module is missing.
   */
  async function sendInProcess(
    run: RunRecord,
    managedBy: string,
    resolved: ResolvedTaskView,
  ): Promise<DispatchOutcome> {
    const dispatcher = dependencies.findManagedDispatcher(managedBy)

    return dispatcher === undefined
      ? failed(`This agent is run by the "${managedBy}" module, which this deployment does not include`)
      : dispatcher(dispatchPayload(run, resolved))
  }

  /**
   * @returns The header to send, null for none, or undefined when the stored
   *   header will not decrypt. That fault is Kelpie's key, not the agent's
   *   endpoint: it is logged, and the caller fails the run with a reason that
   *   points at the key so nobody debugs a healthy agent.
   */
  function openAuthHeader(run: RunRecord, agent: AgentRecord): string | null | undefined {
    if (agent.authHeaderEncrypted === null) {
      return null
    }

    try {
      return dependencies.cipher.open(agent.authHeaderEncrypted)
    } catch (error: unknown) {
      if (!(error instanceof SecretDecryptionError)) {
        throw error
      }

      dependencies.log.error('agent auth header could not be decrypted', {
        agentId: agent.id,
        runId: run.id,
        error: describeThrown(error),
      })

      return undefined
    }
  }

  async function sendOverHttp(
    run: RunRecord,
    agent: AgentRecord,
    resolved: ResolvedTaskView,
    signal: AbortSignal | undefined,
  ): Promise<SendOutcome> {
    const authHeader = openAuthHeader(run, agent)

    if (authHeader === undefined) {
      return failed(
        'The stored auth header could not be decrypted; check SECRET_ENCRYPTION_KEY, then save the header again',
      )
    }

    return dependencies.send({
      url: agent.endpoint,
      body: JSON.stringify(dispatchPayload(run, resolved)),
      headers: {
        'content-type': 'application/json',
        ...(authHeader === null ? {} : { authorization: authHeader }),
      },
    }, signal)
  }

  function logFailure(run: RunRecord, agent: AgentRecord, outcome: SendOutcome): void {
    dependencies.log.warn('agent dispatch failed', {
      agentId: agent.id,
      runId: run.id,
      taskId: run.taskId,
      ...(agent.managedBy === null ? {} : { managedBy: agent.managedBy }),
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.kelpieFault === true ? { kelpieFault: true } : {}),
      ...(outcome.blockedAddress === undefined ? {} : { blockedAddress: outcome.blockedAddress }),
      ...(outcome.logDetail === undefined ? {} : { cause: outcome.logDetail }),
    })
  }

  /**
   * Sends the run and answers its outcome. A dispatcher or sender that throws
   * is the engine's own boundary: whatever slipped past the paths above
   * still lands on the run as a failure.
   */
  async function attempt(
    run: RunRecord,
    agent: AgentRecord,
    resolved: ResolvedTaskView,
    signal: AbortSignal | undefined,
  ): Promise<SendOutcome> {
    try {
      return agent.managedBy === null
        ? await sendOverHttp(run, agent, resolved, signal)
        : await sendInProcess(run, agent.managedBy, resolved)
    } catch (error: unknown) {
      dependencies.log.error('agent dispatch could not be attempted', {
        agentId: agent.id,
        runId: run.id,
        error: describeThrown(error),
      })

      return failed(describeThrown(error))
    }
  }

  async function dispatch(
    run: RunRecord,
    agent: AgentRecord,
    resolved: ResolvedTaskView,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = await repository.startRun(dependencies.db, run.id, dependencies.now())

    if (started === undefined) {
      dependencies.log.debug('agent run not dispatched: it is no longer queued', { runId: run.id })

      return
    }

    const outcome = await attempt(started, agent, resolved, signal)

    if (!outcome.delivered) {
      logFailure(started, agent, outcome)
    }

    if (!(await settle(started, agent.managedBy, outcome))) {
      // The dead-letter handler ended the run first (the job expired), or
      // the run went with its agent. The outcome above is not on the run.
      dependencies.log.warn('agent run had already ended when its dispatch settled', {
        runId: started.id,
        delivered: outcome.delivered,
      })
    }
  }

  return {
    async dispatchRun(data, log, signal) {
      const run = await repository.findRun(dependencies.db, data.workspaceId, data.runId)

      if (run === undefined || run.status !== 'queued') {
        log.debug('agent run not dispatched: it is gone or no longer queued', { runId: data.runId })

        return
      }

      const prepared = await prepare(run, data.targetType)

      if (prepared.kind === 'gone') {
        log.warn('agent run failed before dispatch', { runId: run.id, reason: prepared.reason })
        await settle(run, prepared.managedBy, failed(prepared.reason))

        return
      }

      await dispatch(run, prepared.agent, prepared.resolved, signal)
    },

    dispatch,

    async failAbandonedRun(data, log) {
      const run = await repository.findRun(dependencies.db, data.workspaceId, data.runId)

      if (run === undefined || (run.status !== 'queued' && run.status !== 'running')) {
        return
      }

      const agent = await repository.findAgent(dependencies.db, run.workspaceId, run.agentId)

      log.warn('agent run failed: its dispatch did not finish', { runId: run.id })
      await settle(run, agent?.managedBy ?? null, failed(ABANDONED_RUN_REASON))
    },
  }
}

export function defineDispatchJob(engine: DispatchEngine): JobDefinition<DispatchJobData> {
  return {
    name: DISPATCH_AGENT_RUN_JOB,
    schema: dispatchJobDataSchema,
    // No retry: see the note at the top.
    defaults: {
      retryLimit: 0,
      expireInSeconds: DISPATCH_EXPIRE_SECONDS,
      localConcurrency: DISPATCH_LOCAL_CONCURRENCY,
      groupConcurrency: DISPATCH_GROUP_CONCURRENCY,
    },
    handler: ({ data, log, signal }) => engine.dispatchRun(data, log, signal),
    onDeadLetter: ({ data, log }) => engine.failAbandonedRun(data, log),
  }
}

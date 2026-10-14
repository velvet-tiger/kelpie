import type { ZodType } from 'zod'

import type { Logger } from './logger.ts'

/**
 * The port core runs background work through.
 *
 * A module declares a handle at register time with `context.jobs.define(...)`
 * and enqueues against it from a service. The insert lives inside the same
 * Drizzle transaction as the write it belongs to, so a rolled-back write
 * never leaves an orphan job behind. Handlers run out of process — on the
 * worker entry point, or inline when the API runs its own worker — and see
 * the same payload the caller passed, validated against the module's Zod
 * schema before it reaches user code.
 *
 * The port itself knows nothing about pg-boss. `runtime/jobs.ts` binds it to
 * a real provider at boot; tests bind it to a stub. Nothing outside the
 * runtime imports the provider directly.
 *
 * Why a handle rather than a global name map: consumers of `@kelpie/server`
 * installed from npm lost the `KelpieEventMap` augmentation until every
 * catalog was pulled in from the entry point (see
 * `modules/eventCatalogs.ts`). A handle keeps the payload type on the value
 * the module exports, so `enqueue(handle, data)` typechecks without
 * declaration merging across the package boundary.
 */

/**
 * Marker property carrying the handle's payload type. Never assigned at
 * runtime; the `?` on the property makes an untagged plain object satisfy the
 * shape at read time, so a stub handle in a test can be built without
 * `unsafeCast`.
 */
declare const JobHandleDataMarker: unique symbol

/** A typed reference a module exports after `define()`. */
export interface JobHandle<Data> {
  readonly name: string
  readonly [JobHandleDataMarker]?: Data
}

/**
 * Defaults every enqueue on this queue inherits, unless the caller overrides
 * on a per-`enqueue` basis. `localConcurrency` and `groupConcurrency` size the
 * work loop on the worker; the rest match pg-boss's `QueueOptions` names.
 *
 * `retryDelay` is in seconds. pg-boss's default is 0 (immediate retry).
 * `retryLimit` counts the retries pg-boss does after the first run; a job
 * with `retryLimit: 2` runs at most three times.
 */
export interface JobDefaults {
  readonly retryLimit?: number
  readonly retryDelay?: number
  readonly retryBackoff?: boolean
  readonly retryDelayMax?: number
  readonly expireInSeconds?: number
  /** How many jobs of this queue one process runs at the same time. */
  readonly localConcurrency?: number
  /**
   * The most jobs of one group (`EnqueueOptions.group`) that run at the same
   * time, across every process that works this queue. A job with no group is
   * not limited by it.
   *
   * Global, not per process. pg-boss has both: `localGroupConcurrency` counts
   * in the memory of one worker and so allows that many per process, and
   * `groupConcurrency` counts the group's `active` rows in `pgboss.job` inside
   * the fetch statement. The point of a group limit here is fairness between
   * tenants, and a per-process count would let one tenant take every slot
   * once a deployment runs enough workers. So this is the global one.
   *
   * A plain number only. pg-boss also takes a default plus a limit per
   * `group.tier`; nothing in core needs tiers yet.
   *
   * The count and the claim are one statement, but two processes that fetch
   * at the same moment each read the count before the other claims. So the
   * limit can be passed by a few jobs for a moment, at most by the number of
   * workers fetching together. It is a bound for fairness, not a lock.
   *
   * Set it below `localConcurrency`. A group limit at or above the number of
   * workers lets one group fill them all.
   */
  readonly groupConcurrency?: number
}

/**
 * The group a job counts against for `JobDefaults.groupConcurrency`. The same
 * shape as pg-boss's `GroupOptions`. `tier` has no effect while
 * `groupConcurrency` is a plain number; it is here so a later tier limit needs
 * no change to callers.
 */
export interface JobGroup {
  readonly id: string
  readonly tier?: string
}

/** Passed to a job handler when a worker picks the job up. */
export interface JobContext<Data> {
  readonly id: string
  readonly data: Data
  readonly log: Logger
  /** Fires when pg-boss decides the job has expired. Long-running handlers should honour it. */
  readonly signal: AbortSignal
  /**
   * True when this run is the last one: the retries are used, so the queue
   * does not run the job again if the handler throws. False while a retry
   * remains. A handler reads it to record a failure that nothing will clear.
   *
   * The queue sets it on every run. It is optional so that a test which calls
   * a handler with a context of its own, and gives no value, still compiles;
   * a handler reads an absent value as false.
   */
  readonly lastAttempt?: boolean
  /**
   * Which run this is: 1 on the first run, 2 on the first retry, and so on.
   * A run that a dead worker left and supervision put back counts too.
   *
   * The queue sets it on every run. It is optional for the reason
   * `lastAttempt` is; a handler reads an absent value as 1.
   */
  readonly attempt?: number
}

export type JobHandler<Data> = (context: JobContext<Data>) => Promise<void>

/** Passed to `onDeadLetter` when a job arrives in its dead-letter queue. */
export interface DeadLetterContext<Data> {
  /** The id of the job in the dead-letter queue, not of the job that ended. */
  readonly id: string
  /** The payload of the job that ended, parsed with the definition's schema. */
  readonly data: Data
  readonly log: Logger
}

export type DeadLetterHandler<Data> = (context: DeadLetterContext<Data>) => Promise<void>

export interface JobDefinition<Data> {
  /**
   * The queue name pg-boss stores against. Must be unique across the
   * assembly; a second `define()` with the same name fails boot.
   *
   * Prefix with the module id — `webhooks.deliver`, `agent-tasks.dispatch` —
   * so operators reading `pgboss.job` see who owns it.
   */
  readonly name: string
  /**
   * Parses the payload at handle time before it reaches user code. A job
   * whose payload no longer matches fails, retries, and eventually
   * dead-letters like any other failure.
   */
  readonly schema: ZodType<Data>
  readonly handler: JobHandler<Data>
  readonly defaults?: JobDefaults
  /**
   * Runs once for each job that ends in the dead-letter queue: the queue
   * gave up on it and does not run `handler` for it again. A module uses it
   * to record that the work was not done.
   *
   * A job gets there in two ways. Its handler threw on the last run; that
   * handler saw `lastAttempt` and could record the failure itself. Or the
   * worker died during the last run, and supervision ended the job; no
   * handler ran to the end, so only this function can record it. It runs in
   * both cases, so write it to do nothing when the handler has already made
   * its record.
   *
   * It runs on a worker, some seconds after the job ended. When it throws,
   * the queue runs it again a small number of times, so it must be safe to
   * run more than once. A payload that does not match `schema` is written
   * to the log and the function does not run.
   *
   * Without it, a job in the dead-letter queue stays there untouched, for an
   * operator to read. With it, the job in the dead-letter queue completes
   * when the function returns; the queue keeps the row for some days.
   */
  readonly onDeadLetter?: DeadLetterHandler<Data>
}

/**
 * The registration surface exposed to a module through `context.jobs`. Modules
 * hand a definition in and receive a typed handle to enqueue against.
 */
export interface JobRegistry {
  define<Data>(definition: JobDefinition<Data>): JobHandle<Data>
}

/**
 * Options a caller may override per `enqueue`. Deliberately narrow: features
 * beyond retries, a singleton key, a deferred start and a group are out of
 * scope until a consumer needs them (cost and maintainability trade-offs).
 */
export interface EnqueueOptions {
  readonly retryLimit?: number
  readonly retryBackoff?: boolean
  readonly singletonKey?: string
  readonly startAfter?: number | string | Date
  /**
   * The group the job counts against for the queue's `groupConcurrency`.
   * A module passes the workspace id, so that one workspace's backlog cannot
   * hold every worker of the queue.
   */
  readonly group?: JobGroup
}

/**
 * Exposed on the transaction context next to `events`. `enqueue` runs its
 * insert inside the caller's transaction via pg-boss's `fromDrizzle` adapter,
 * so a rollback discards the job with the write.
 */
export interface TransactionJobs {
  enqueue<Data>(
    handle: JobHandle<Data>,
    data: Data,
    options?: EnqueueOptions,
  ): Promise<string | null>
}

/** The name pg-boss stores the dead-letter queue under, given a handle name. */
export function deadLetterQueueName(jobName: string): string {
  return `${jobName}.dead`
}

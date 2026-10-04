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
 * on a per-`enqueue` basis. `localConcurrency` sizes the work loop on the
 * worker; the rest match pg-boss's `QueueOptions` names.
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
  readonly localConcurrency?: number
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
 * beyond retries, a singleton key, and a deferred start are out of scope until
 * a consumer needs them (cost and maintainability trade-offs).
 */
export interface EnqueueOptions {
  readonly retryLimit?: number
  readonly retryBackoff?: boolean
  readonly singletonKey?: string
  readonly startAfter?: number | string | Date
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

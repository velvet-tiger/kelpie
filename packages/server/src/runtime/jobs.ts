import { sql } from 'drizzle-orm'
import { PgBoss, fromDrizzle } from 'pg-boss'
import type { Job } from 'pg-boss'

import { describeThrown } from '../lib/errors.ts'
import type { Logger } from '../lib/logger.ts'
import type {
  EnqueueOptions,
  JobContext,
  JobDefinition,
  JobHandle,
  JobRegistry,
} from '../lib/jobs.ts'
import { deadLetterQueueName } from '../lib/jobs.ts'
import type { Transaction } from './transaction.ts'

/**
 * The pg-boss provider that binds the job port defined in `lib/jobs.ts` to a
 * real Postgres-backed queue.
 *
 * Two phases:
 *
 * 1. Registration, at boot. Modules call `context.jobs.define(...)` during
 *    `register`. The registry records the definition (fails boot on a
 *    duplicate name) and returns the handle. Nothing touches the database
 *    yet.
 * 2. `start()`, from the entry point. Opens the pg-boss instance, primes the
 *    queue cache, and calls `createQueue` for every registered handle plus
 *    its dead-letter queue. Idempotent (`create_queue` upserts).
 *
 * The API and the worker both call `start()`: the API needs a boss instance
 * to insert jobs on request-scoped transactions; the worker adds a
 * `startWorking()` step that runs `work()` per handle.
 *
 * @see modules.md for how jobs sit next to the event bus.
 */

/**
 * The pg-boss schema name. Fixed here rather than configurable per assembly:
 * self-hosters run one Postgres per Kelpie install and would gain nothing
 * from renaming the schema.
 */
const PGBOSS_SCHEMA = 'pgboss'

const DEFAULT_LOCAL_CONCURRENCY = 5

/**
 * Base polling floor. `useListenNotify` wakes workers immediately on a
 * `notify: true` queue, so polling is a slow backstop.
 */
const NOTIFY_POLLING_INTERVAL_SECONDS = 30

interface RegisteredJob<Data> {
  readonly definition: JobDefinition<Data>
  readonly handle: JobHandle<Data>
}

export interface JobsRuntimeOptions {
  readonly connectionString: string
  readonly logger: Logger
  /**
   * Polling floor for queues where LISTEN/NOTIFY is unavailable. Kept high
   * in production (default 30s) so idle workers cost nothing; tests pass a
   * short value so a job runs within one tick of enqueue even if the
   * listener never opened.
   */
  readonly pollingIntervalSeconds?: number
  /**
   * How many workers the runtime spins up per handle when a definition does
   * not override `defaults.localConcurrency`. Matches pg-boss's default.
   */
  readonly defaultLocalConcurrency?: number
}

export interface JobsRuntime {
  /** The port modules bind to at register time. */
  readonly registry: JobRegistry
  /** True once `register` has been called with this name. Used by tests. */
  hasHandle(name: string): boolean
  /**
   * Applies pg-boss's own schema migration. Idempotent: safe to run on every
   * boot. Uses a throwaway `PgBoss` in `migrate: true, createSchema: true`
   * mode, matching the release-command flow the cloud runs.
   */
  migrate(): Promise<void>
  /**
   * Opens the persistent pg-boss instance and declares every registered
   * queue plus its dead-letter counterpart. Must run before `enqueueOnTx`
   * or `startWorking`. `migrate: false` here: `migrate()` above owns that
   * step, so instances never race the migration.
   */
  start(): Promise<void>
  /**
   * Starts the `work()` loop for every registered handle. The worker entry
   * point calls this; the API calls it too unless `--no-worker` is set.
   * Handler errors are logged and rethrown so pg-boss retries or
   * dead-letters the job.
   */
  startWorking(): Promise<void>
  /**
   * Enqueues a job on the caller's transaction via `fromDrizzle(tx, sql)`.
   * The insert commits with the surrounding write; a rollback discards it.
   * Rejects when no `handle` was registered for `name` (this would be a
   * boot-time bug, not a runtime one).
   */
  enqueueOnTx<Data>(
    tx: Transaction,
    handle: JobHandle<Data>,
    data: Data,
    options?: EnqueueOptions,
  ): Promise<string | null>
  /**
   * Drains in-flight work and closes the pg-boss instance. `offWork({wait:
   * true})` awaits every handler mid-flight; `boss.stop` then tears down
   * the connection pool.
   */
  stop(): Promise<void>
}

export function createJobsRuntime(options: JobsRuntimeOptions): JobsRuntime {
  const registered = new Map<string, RegisteredJob<unknown>>()
  // Tracks which handles have had `createQueue` run and which have had
  // `work()` called, so a runtime that registers a fresh handle after
  // `start()` (a test that adds one mid-suite) still gets its queue built
  // and its worker started without redoing the ones already up.
  const queuesCreated = new Set<string>()
  const workersStarted = new Set<string>()
  let boss: PgBoss | undefined

  function requireBoss(): PgBoss {
    if (boss === undefined) {
      throw new Error('jobs runtime used before start(): call jobs.start() at boot')
    }
    return boss
  }

  const registry: JobRegistry = {
    define<Data>(definition: JobDefinition<Data>): JobHandle<Data> {
      if (registered.has(definition.name)) {
        throw new Error(`job "${definition.name}" is defined twice`)
      }

      const handle: JobHandle<Data> = { name: definition.name }
      registered.set(definition.name, {
        definition: definition as JobDefinition<unknown>,
        handle: handle as JobHandle<unknown>,
      })

      return handle
    },
  }

  async function migrate(): Promise<void> {
    // A throwaway instance in migrate/createSchema mode. Cheaper than
    // vendoring the SQL: pg-boss owns its schema, and `getConstructionPlans`
    // / `getMigrationPlans` produce statements we would just execute in the
    // same order the library does itself. `supervise: false, schedule: false`
    // keeps the instance from spawning any background work while it lives.
    const migrator = new PgBoss({
      connectionString: options.connectionString,
      schema: PGBOSS_SCHEMA,
      migrate: true,
      createSchema: true,
      supervise: false,
      schedule: false,
    })

    try {
      await migrator.start()
    } finally {
      await migrator.stop({ graceful: false, close: true, timeout: 5_000 })
    }
  }

  async function ensureQueuesFor(instance: PgBoss): Promise<void> {
    for (const { definition } of registered.values()) {
      if (queuesCreated.has(definition.name)) {
        continue
      }

      const deadLetter = deadLetterQueueName(definition.name)

      // Dead letter queue must exist before the main queue references it.
      await instance.createQueue(deadLetter, {
        policy: 'standard',
        notify: false,
      })

      await instance.createQueue(definition.name, {
        policy: 'standard',
        deadLetter,
        notify: true,
        ...(definition.defaults?.retryLimit === undefined
          ? {}
          : { retryLimit: definition.defaults.retryLimit }),
        ...(definition.defaults?.retryDelay === undefined
          ? {}
          : { retryDelay: definition.defaults.retryDelay }),
        ...(definition.defaults?.retryBackoff === undefined
          ? {}
          : { retryBackoff: definition.defaults.retryBackoff }),
        ...(definition.defaults?.retryDelayMax === undefined
          ? {}
          : { retryDelayMax: definition.defaults.retryDelayMax }),
        ...(definition.defaults?.expireInSeconds === undefined
          ? {}
          : { expireInSeconds: definition.defaults.expireInSeconds }),
      })

      queuesCreated.add(definition.name)
    }
  }

  async function start(): Promise<void> {
    if (boss === undefined) {
      const instance = new PgBoss({
        connectionString: options.connectionString,
        schema: PGBOSS_SCHEMA,
        migrate: false,
        createSchema: false,
        supervise: false,
        schedule: false,
        useListenNotify: true,
      })

      instance.on('error', (error: unknown) => {
        options.logger.error('pg-boss error', { error: describeThrown(error) })
      })

      await instance.start()
      boss = instance
    }

    await ensureQueuesFor(boss)
  }

  async function startWorking(): Promise<void> {
    const instance = requireBoss()
    const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2
    const defaultLocalConcurrency = options.defaultLocalConcurrency ?? DEFAULT_LOCAL_CONCURRENCY

    for (const { definition } of registered.values()) {
      if (workersStarted.has(definition.name)) {
        continue
      }

      const localConcurrency = definition.defaults?.localConcurrency ?? defaultLocalConcurrency

      await instance.work(
        definition.name,
        {
          batchSize: 1,
          localConcurrency,
          pollingIntervalSeconds,
          notifyPollingIntervalSeconds: NOTIFY_POLLING_INTERVAL_SECONDS,
        },
        async (batch: Job<unknown>[]) => {
          const job = batch[0]
          if (job === undefined) {
            return
          }

          const parsed = definition.schema.safeParse(job.data)

          if (!parsed.success) {
            options.logger.error('job payload rejected by schema', {
              job: definition.name,
              id: job.id,
              issues: parsed.error.issues,
            })
            throw new Error(
              `job "${definition.name}" payload does not match its schema: ${parsed.error.issues
                .map((issue) => issue.message)
                .join('; ')}`,
            )
          }

          const jobLogger = options.logger.child({ job: definition.name, jobId: job.id })
          const context: JobContext<unknown> = {
            id: job.id,
            data: parsed.data,
            log: jobLogger,
            signal: job.signal,
          }

          try {
            await definition.handler(context)
          } catch (error: unknown) {
            jobLogger.error('job handler failed', { error: describeThrown(error) })
            throw error
          }
        },
      )

      workersStarted.add(definition.name)
    }
  }

  async function enqueueOnTx<Data>(
    tx: Transaction,
    handle: JobHandle<Data>,
    data: Data,
    enqueueOptions: EnqueueOptions = {},
  ): Promise<string | null> {
    const instance = requireBoss()
    const entry = registered.get(handle.name)

    if (entry === undefined) {
      throw new Error(`enqueue for unregistered job "${handle.name}"`)
    }

    return instance.send(
      handle.name,
      data as object,
      {
        db: fromDrizzle(tx, sql),
        ...(enqueueOptions.retryLimit === undefined ? {} : { retryLimit: enqueueOptions.retryLimit }),
        ...(enqueueOptions.retryBackoff === undefined
          ? {}
          : { retryBackoff: enqueueOptions.retryBackoff }),
        ...(enqueueOptions.singletonKey === undefined
          ? {}
          : { singletonKey: enqueueOptions.singletonKey }),
        ...(enqueueOptions.startAfter === undefined ? {} : { startAfter: enqueueOptions.startAfter }),
      },
    )
  }

  async function stop(): Promise<void> {
    const instance = boss
    if (instance === undefined) {
      return
    }

    for (const name of workersStarted) {
      try {
        await instance.offWork(name, { wait: true })
      } catch (error: unknown) {
        options.logger.error('offWork failed', {
          job: name,
          error: describeThrown(error),
        })
      }
    }
    workersStarted.clear()

    await instance.stop({ graceful: true, close: true, timeout: 30_000 })
    boss = undefined
    queuesCreated.clear()
  }

  return {
    registry,
    hasHandle: (name) => registered.has(name),
    migrate,
    start,
    startWorking,
    enqueueOnTx,
    stop,
  }
}

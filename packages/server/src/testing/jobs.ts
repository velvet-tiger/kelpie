import type { JobDefinition, JobHandle, JobRegistry } from '../lib/jobs.ts'
import { createLogger } from '../lib/logger.ts'
import type { EnqueueOnTransaction } from '../runtime/transaction.ts'

/**
 * A job registry for tests that accepts every `define` and runs nothing.
 *
 * A core module defines its jobs at register time, so a test app booting
 * `coreModules` needs a registry that takes the definitions. Nothing here
 * polls a queue: a test that wants a handler to run takes its definition from
 * `definitions` and calls `handler` itself, with the payload it expects.
 * Whether a write enqueued a job is a separate question, answered by giving
 * the services a real `enqueueOnTx` (`TestDatabase.jobs`).
 */
export interface RecordingJobsRegistry extends JobRegistry {
  /** Every definition, by job name. */
  readonly definitions: ReadonlyMap<string, JobDefinition<unknown>>
}

export function createRecordingJobsRegistry(): RecordingJobsRegistry {
  const definitions = new Map<string, JobDefinition<unknown>>()

  return {
    definitions,
    define<Data>(definition: JobDefinition<Data>): JobHandle<Data> {
      if (definitions.has(definition.name)) {
        throw new Error(`job "${definition.name}" is defined twice`)
      }

      definitions.set(definition.name, definition as JobDefinition<unknown>)

      return { name: definition.name }
    },
  }
}

/** A job a service enqueued: the queue it went to and its payload. */
export interface QueuedJob {
  readonly name: string
  readonly data: unknown
}

/**
 * A queue in memory, for suites that do not test the queue itself.
 *
 * Sign-up adds an email job, so almost every suite enqueues, and most have no
 * interest in what happens next. This takes each job and keeps it in `queued`
 * until a test runs it with `runJobs`. The payload goes through JSON, as it
 * does on its way into the real queue.
 *
 * It does not join the transaction: a job added by a write that then rolls
 * back stays in `queued`. A test of that rule uses the real queue
 * (`TestDatabase.jobs.enqueueOnTx`) and reads `pgboss.job`.
 */
export interface MemoryJobQueue {
  readonly enqueueOnTx: EnqueueOnTransaction
  /** Every job not yet run, oldest first. `runJobs` takes them out. */
  readonly queued: QueuedJob[]
}

export function createMemoryJobQueue(): MemoryJobQueue {
  const queued: QueuedJob[] = []
  let count = 0

  return {
    queued,
    enqueueOnTx(_tx, handle, data) {
      count += 1
      queued.push({ name: handle.name, data: JSON.parse(JSON.stringify(data)) as unknown })

      return Promise.resolve(`job_memory_${String(count)}`)
    },
  }
}

const silentLogger = createLogger({ level: 'error', transports: [] })

export interface RunJobsOptions {
  /** The `lastAttempt` each handler gets. Default false. */
  readonly lastAttempt?: boolean
}

/**
 * Runs every job in `queue` once, as a worker would: the payload is parsed
 * with the definition's schema, then handed to its handler. Jobs a handler
 * adds while it runs are left for the next call.
 *
 * A job that fails goes back on `queue`, the way the real queue keeps it for
 * a retry, and the rest still run.
 *
 * `options.lastAttempt` is the `lastAttempt` each handler gets. The default is
 * false: a retry remains, as on the first run of a job with retries. A test
 * passes true to run the jobs as the queue runs them when no retry remains.
 *
 * @throws AggregateError after every job has run, when one or more failed.
 */
export async function runJobs(
  registry: RecordingJobsRegistry,
  queue: QueuedJob[],
  options: RunJobsOptions = {},
): Promise<void> {
  const failures: unknown[] = []

  for (const job of queue.splice(0)) {
    const definition = registry.definitions.get(job.name)

    if (definition === undefined) {
      throw new Error(`no module registered a job named "${job.name}"`)
    }

    try {
      await definition.handler({
        id: 'job_test',
        data: definition.schema.parse(job.data),
        log: silentLogger,
        signal: new AbortController().signal,
        lastAttempt: options.lastAttempt ?? false,
      })
    } catch (error: unknown) {
      queue.push(job)
      failures.push(error)
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `${String(failures.length)} job(s) failed`)
  }
}

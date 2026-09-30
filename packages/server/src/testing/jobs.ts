import type { JobDefinition, JobHandle, JobRegistry } from '../lib/jobs.ts'

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

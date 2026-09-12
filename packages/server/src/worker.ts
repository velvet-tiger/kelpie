import type { AssemblyBoot } from './boot.ts'

/**
 * Runs after `bootAssembly` on the worker entry point.
 *
 * Applies pg-boss's schema (idempotent), opens the persistent pg-boss
 * instance, and starts the work loop for every registered handle. Does not
 * call `createApp`: workers process queues, they do not answer HTTP.
 *
 * The API entry point calls the same steps unless started with `--no-worker`,
 * so an OSS assembly runs one container that both serves and works. Cloud
 * runs a separate worker process group and passes `--no-worker` to the API,
 * so the two never contend on the same handler.
 */
export async function startWorker(boot: AssemblyBoot): Promise<void> {
  await boot.jobs.migrate()
  await boot.jobs.start()
  await boot.jobs.startWorking()
  boot.logger.info('worker started', { runtimeMode: boot.config.runtimeMode })
}

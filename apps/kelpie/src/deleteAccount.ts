import {
  ConfigurationError,
  ModuleBootError,
  ModuleConfigFileError,
  bootAssembly,
  runAccountDeletion,
} from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * Deletes one account by its address, for an operator:
 *
 *   npm run delete-account -- person@example.com
 *
 * The rules are `runAccountDeletion`'s: every module's deletion handler runs,
 * so an account that owns a workspace is refused. It needs no session and no
 * password, which is why it is a shell command and nothing else.
 *
 * Exit codes:
 *
 *   0  The account is gone.
 *   1  No address was given, or the configuration or module list is wrong.
 *   2  No account has that address. Nothing changed.
 *   3  A module refused, for the reason printed. Nothing changed.
 *
 * It boots the assembly and starts the job runtime but not its work loops, as
 * `server.ts --no-worker` does, so a subscriber that queues follow-up work can
 * queue it. Migrations must already be applied.
 */

const USAGE = 'Usage: npm run delete-account -- <email>'

function reportFatal(message: string): void {
  process.stderr.write(`${message}\n`)
}

async function main(): Promise<number> {
  const [email, ...extra] = process.argv.slice(2)

  if (email === undefined || email.trim().length === 0 || extra.length > 0) {
    reportFatal(USAGE)

    return 1
  }

  const boot = await bootAssembly(kelpieConfig, process.env)

  await boot.jobs.start()

  try {
    return await runAccountDeletion({
      db: boot.database.db,
      transaction: boot.transaction,
      runAccountDeletionHandlers: boot.contributions.runAccountDeletionHandlers,
      email,
    })
  } finally {
    // The events publish after commit without being awaited. Drained before
    // the database closes, or `auth.user.deleted` reaches no subscriber.
    await boot.contributions.events.drain()
    await boot.jobs.stop()
    await boot.database.close()
  }
}

try {
  process.exit(await main())
} catch (error: unknown) {
  if (error instanceof ConfigurationError) {
    reportFatal(error.message)
    reportFatal('Copy .env.example to .env and fill it in, or set these variables in the environment.')
    process.exit(1)
  }

  if (error instanceof ModuleConfigFileError) {
    reportFatal(error.message)
    reportFatal('Fix the file at KELPIE_MODULE_CONFIG_PATH, or unset it.')
    process.exit(1)
  }

  if (error instanceof ModuleBootError) {
    reportFatal(error.message)
    reportFatal('Fix the module list in apps/kelpie/kelpie.config.ts, or the configuration it needs.')
    process.exit(1)
  }

  throw error
}

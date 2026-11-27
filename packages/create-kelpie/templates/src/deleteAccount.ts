import { bootAssembly, operatorAssemblyFrom, runDeleteAccountCommand } from '@kelpie/server'

import kelpieConfig from '../kelpie.config.ts'

/**
 * Deletes one account by its address, for an operator. The first run prints
 * what it would delete and deletes nothing; the same run with `--yes` deletes:
 *
 *   npm run delete-account -- person@example.com
 *   npm run delete-account -- person@example.com --yes
 *
 * The rules are `runDeleteAccountCommand`'s, in `@kelpie/server`: every
 * module's deletion handler runs, so an account that owns a workspace is
 * refused. It needs no session and no password, which is why it is a shell
 * command and nothing else. Migrations must already be applied.
 *
 * Exit codes:
 *
 *   0  The account is gone.
 *   1  No address or a bad argument, a configuration that will not boot, or
 *      no --yes. Nothing changed.
 *   2  No account has that address, or it moved off it while this ran.
 *      Nothing changed.
 *   3  A module refused, for the reason printed. Nothing changed.
 *   4  Something failed that is not a refusal: the database, a migration, a
 *      module. One line says what. Nothing changed.
 */

process.exit(
  await runDeleteAccountCommand({
    argv: process.argv.slice(2),
    boot: async () => operatorAssemblyFrom(await bootAssembly(kelpieConfig, process.env)),
    configurationHint: 'Check .env against the table in README.md, and the module list in kelpie.config.ts.',
  }),
)

import type { AssemblyBoot } from '../../boot.ts'
import { ConfigurationError } from '../../lib/config.ts'
import { describeWriteFailure, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { ModuleConfigFileError } from '../../lib/moduleConfig.ts'
import type { AccountDeletion } from '../../runtime/module.ts'
import { ModuleBootError } from '../../runtime/order.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { deleteAccountRecord } from './deletion.ts'
import * as repository from './repository.ts'

/**
 * An operator deleting an account by its address, from a shell.
 *
 * For an account whose owner cannot sign in to delete it: a lost password and
 * a dead mailbox, or a support request. It skips the two checks that stand in
 * for the person (a session, and the current password), because an operator
 * with shell access to the deployment is past both already. Everything else
 * is the self-service path: the same transaction, and every module's deletion
 * handler, so an account that owns a workspace is refused here too.
 *
 * It deletes nothing unless asked twice. The first run prints what it would
 * delete and where: the database, the account, and its workspaces. The same
 * run with `--yes` prints that again and deletes.
 *
 * The event's actor is `system`. Nothing in core names an operator, and the
 * account itself did not ask.
 */

/** The account is gone. */
export const ACCOUNT_DELETION_EXIT_DELETED = 0
/** No address or a bad argument, a configuration or module list that will not boot, or no `--yes`. Nothing changed. */
export const ACCOUNT_DELETION_EXIT_USAGE = 1
/** No account has that address, or the account moved off it while this ran. Nothing changed. */
export const ACCOUNT_DELETION_EXIT_UNKNOWN = 2
/** A module refused the deletion, for a reason the report gives. Nothing changed. */
export const ACCOUNT_DELETION_EXIT_REFUSED = 3
/** Something failed that is not a refusal: the database, a migration, a handler. Nothing changed. */
export const ACCOUNT_DELETION_EXIT_FAULT = 4

const USAGE = 'Usage: npm run delete-account -- <email> [--yes]'

/** Where the command writes. Progress goes to `report`, refusals and faults to `reportFatal`. */
export interface OperatorOutput {
  readonly report?: (line: string) => void
  readonly reportFatal?: (line: string) => void
}

export interface RunAccountDeletionOptions extends OperatorOutput {
  readonly db: Database
  /** The assembly's transaction scope (`AssemblyBoot.transaction`), so the events reach its subscribers. */
  readonly transaction: TransactionScope
  /** The modules' handlers (`ModuleContributions.runAccountDeletionHandlers`). */
  readonly runAccountDeletionHandlers: (deletion: AccountDeletion) => Promise<void>
  /** The database as the target line names it. `describeDatabase` makes one from a URL. */
  readonly databaseTarget: string
  /** The address as the operator typed it. Matched the way sign-in matches it. */
  readonly email: string
  /** True for `--yes`. Without it nothing is deleted. */
  readonly confirmed: boolean
}

function defaultReport(line: string): void {
  process.stdout.write(`${line}\n`)
}

function defaultReportFatal(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Makes a value safe to print to a terminal.
 *
 * A workspace name, an address and an error message are text that somebody
 * else typed. Printed raw, a control character in one moves the cursor,
 * rewrites what the operator already read, or sets the window title. Every C0
 * and C1 control, DEL, and the two Unicode line and paragraph separators come
 * out as a `\u` escape instead.
 */
export function printable(value: string): string {
  return value.replaceAll(
    // Matching control characters is the point: they are what gets escaped.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * The database a URL names, as `host:port/name`. Never the user or the
 * password: the line goes to a terminal, and from there into scrollback and
 * support tickets.
 */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url)
    const port = parsed.port.length > 0 ? `:${parsed.port}` : ''

    return `${parsed.hostname}${port}${parsed.pathname}`
  } catch {
    // An unreadable URL would have failed the boot first; say so rather than print it.
    return '(a database URL that does not parse)'
  }
}

/** Thrown under the row lock when the account no longer has the address the operator typed. */
class AddressMovedError extends Error {}

/**
 * Prints what the deletion would touch, and deletes it when `confirmed`.
 *
 * The account is found by address once, and deleted by the id that lookup
 * found. Under the row lock the address is read again: an account that moved
 * off it in between is not the account the operator was shown, and is left.
 *
 * Publishing happens after commit and is not awaited here. The caller drains
 * the event bus before it closes the database, or a subscriber such as the
 * cloud's directory release never runs.
 *
 * @returns The exit code: `ACCOUNT_DELETION_EXIT_DELETED` (0), `_USAGE` (1) when
 *   not confirmed, `_UNKNOWN` (2) or `_REFUSED` (3).
 * @throws Whatever is not a refusal: a database fault, or a handler that
 *   failed rather than refused. Nothing was deleted.
 */
export async function runAccountDeletion(options: RunAccountDeletionOptions): Promise<number> {
  const report = options.report ?? defaultReport
  const reportFatal = options.reportFatal ?? defaultReportFatal
  const email = options.email.trim().toLowerCase()
  const user = email.length === 0 ? undefined : await repository.findUserByEmail(options.db, email)

  if (user === undefined) {
    reportFatal(`No account has the address ${printable(email)}. Nothing was deleted.`)

    return ACCOUNT_DELETION_EXIT_UNKNOWN
  }

  const workspaces = await repository.listWorkspacesForUser(options.db, user.id)

  report(`Database: ${printable(options.databaseTarget)}`)
  report(`Account: ${printable(user.id)} ${printable(user.email)}`)

  if (workspaces.length === 0) {
    report('Workspaces: none')
  } else {
    report('Workspaces:')

    for (const workspace of workspaces) {
      report(`  ${printable(workspace.id)} ${printable(workspace.name)} (${printable(workspace.role)})`)
    }
  }

  if (!options.confirmed) {
    report('Nothing was deleted. Run the same command with --yes to delete this account.')

    return ACCOUNT_DELETION_EXIT_USAGE
  }

  try {
    const deleted = await deleteAccountRecord(
      { transaction: options.transaction, runDeletionHandlers: options.runAccountDeletionHandlers },
      user.id,
      {
        actor: { kind: 'system' },
        checkLocked: (current) => {
          if (current.email !== user.email) {
            throw new AddressMovedError()
          }
        },
      },
    )

    if (deleted === undefined) {
      reportFatal(`The account ${printable(user.id)} was deleted while this ran. Nothing more was deleted.`)

      return ACCOUNT_DELETION_EXIT_UNKNOWN
    }

    report(`Deleted account ${printable(deleted.userId)} (${printable(deleted.email)}).`)

    return ACCOUNT_DELETION_EXIT_DELETED
  } catch (error: unknown) {
    if (error instanceof AddressMovedError) {
      reportFatal(`The account ${printable(user.id)} moved off the address ${printable(email)} while this ran. Nothing was deleted.`)

      return ACCOUNT_DELETION_EXIT_UNKNOWN
    }

    if (!(error instanceof AppError)) {
      throw error
    }

    reportFatal(`Refused: ${printable(error.message)}. Nothing was deleted.`)

    for (const detail of error.details ?? []) {
      reportFatal(`  ${printable(detail.field)}: ${printable(detail.message)}`)
    }

    return ACCOUNT_DELETION_EXIT_REFUSED
  }
}

/** What the command needs from a booted assembly. `operatorAssemblyFrom` makes one from `bootAssembly`'s result. */
export interface OperatorAssembly {
  readonly db: Database
  /** Read for the target line only, through `describeDatabase`. */
  readonly databaseUrl: string
  readonly transaction: TransactionScope
  readonly runAccountDeletionHandlers: (deletion: AccountDeletion) => Promise<void>
  readonly startJobs: () => Promise<void>
  readonly drainEvents: () => Promise<void>
  readonly stopJobs: () => Promise<void>
  readonly closeDatabase: () => Promise<void>
}

export function operatorAssemblyFrom(boot: AssemblyBoot): OperatorAssembly {
  return {
    db: boot.database.db,
    databaseUrl: boot.config.databaseUrl,
    transaction: boot.transaction,
    runAccountDeletionHandlers: boot.contributions.runAccountDeletionHandlers,
    // The job runtime opens without its work loops, as `server.ts --no-worker`
    // does: a subscriber that queues follow-up work can queue it, and this
    // process runs none of it.
    startJobs: () => boot.jobs.start(),
    drainEvents: () => boot.contributions.events.drain(),
    stopJobs: () => boot.jobs.stop(),
    closeDatabase: () => boot.database.close(),
  }
}

export interface DeleteAccountCommandOptions extends OperatorOutput {
  /** The arguments after the script name. */
  readonly argv: readonly string[]
  /** Boots the assembly. A script passes one bound to its own `kelpie.config.ts`. */
  readonly boot: () => Promise<OperatorAssembly>
  /** Printed after a configuration error, to say where to fix it. */
  readonly configurationHint?: string
}

type ParsedArguments =
  | { readonly kind: 'run'; readonly email: string; readonly confirmed: boolean }
  | { readonly kind: 'usage' }

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional = argv.filter((argument) => !argument.startsWith('--'))
  const flags = argv.filter((argument) => argument.startsWith('--'))
  const [email] = positional

  if (positional.length !== 1 || email === undefined || email.trim().length === 0) {
    return { kind: 'usage' }
  }

  if (flags.some((flag) => flag !== '--yes')) {
    return { kind: 'usage' }
  }

  return { kind: 'run', email, confirmed: flags.includes('--yes') }
}

/** One line about a fault, never its stack, and never a query's parameters. */
function describeFault(error: unknown): string {
  if (postgresErrorCode(error) !== undefined) {
    return describeWriteFailure(error)
  }

  if (error instanceof Error) {
    const [firstLine = ''] = error.message.split('\n')

    return `${error.name}: ${firstLine}`
  }

  return String(error)
}

function isConfigurationFault(error: unknown): error is Error {
  return error instanceof ConfigurationError || error instanceof ModuleConfigFileError || error instanceof ModuleBootError
}

/**
 * The whole `delete-account` command: arguments, boot, deletion, clean-up.
 * Lives here rather than in each assembly's script so every assembly runs the
 * same rules, and so a test can run it.
 *
 * Clean-up always runs, in order: drain the event bus, stop the job runtime,
 * close the database. A step that fails is reported and the next still runs,
 * and none of them changes the exit code the deletion earned.
 *
 * @returns The exit code. See the `ACCOUNT_DELETION_EXIT_*` constants.
 */
export async function runDeleteAccountCommand(options: DeleteAccountCommandOptions): Promise<number> {
  const report = options.report ?? defaultReport
  const reportFatal = options.reportFatal ?? defaultReportFatal
  const parsed = parseArguments(options.argv)

  if (parsed.kind === 'usage') {
    reportFatal(USAGE)

    return ACCOUNT_DELETION_EXIT_USAGE
  }

  let assembly: OperatorAssembly

  try {
    assembly = await options.boot()
  } catch (error: unknown) {
    if (isConfigurationFault(error)) {
      // A configuration error lists one problem a line. Each line is escaped on
      // its own, so the list still reads as a list.
      for (const line of error.message.split('\n')) {
        reportFatal(printable(line))
      }

      if (options.configurationHint !== undefined) {
        reportFatal(options.configurationHint)
      }

      return ACCOUNT_DELETION_EXIT_USAGE
    }

    reportFatal(`Failed: ${printable(describeFault(error))}. Nothing was deleted.`)

    return ACCOUNT_DELETION_EXIT_FAULT
  }

  let code: number = ACCOUNT_DELETION_EXIT_FAULT

  try {
    await assembly.startJobs()

    code = await runAccountDeletion({
      db: assembly.db,
      transaction: assembly.transaction,
      runAccountDeletionHandlers: assembly.runAccountDeletionHandlers,
      databaseTarget: describeDatabase(assembly.databaseUrl),
      email: parsed.email,
      confirmed: parsed.confirmed,
      report,
      reportFatal,
    })
  } catch (error: unknown) {
    reportFatal(`Failed: ${printable(describeFault(error))}. Nothing was deleted.`)
    code = ACCOUNT_DELETION_EXIT_FAULT
  }

  const cleanUp = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error: unknown) {
      reportFatal(`Clean-up failed while ${step}: ${printable(describeFault(error))}`)
    }
  }

  await cleanUp('draining events', assembly.drainEvents)
  await cleanUp('stopping the job runtime', assembly.stopJobs)
  await cleanUp('closing the database', assembly.closeDatabase)

  return code
}

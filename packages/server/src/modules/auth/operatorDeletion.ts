import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { AccountDeletion } from '../../runtime/module.ts'
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
 * The event's actor is `system`. Nothing in core names an operator, and the
 * account itself did not ask.
 */

/** The account is gone. */
export const ACCOUNT_DELETION_EXIT_DELETED = 0
/** No account has that address. Nothing changed. Exit code 1 is the script's, for a configuration or usage error. */
export const ACCOUNT_DELETION_EXIT_UNKNOWN = 2
/** A module refused the deletion, for a reason the report gives. Nothing changed. */
export const ACCOUNT_DELETION_EXIT_REFUSED = 3

export interface RunAccountDeletionOptions {
  readonly db: Database
  /** The assembly's transaction scope (`AssemblyBoot.transaction`), so the events reach its subscribers. */
  readonly transaction: TransactionScope
  /** The modules' handlers (`ModuleContributions.runAccountDeletionHandlers`). */
  readonly runAccountDeletionHandlers: (deletion: AccountDeletion) => Promise<void>
  /** The address as the operator typed it. Matched the way sign-in matches it. */
  readonly email: string
  /** Where progress goes. Defaults to stdout. */
  readonly report?: (line: string) => void
  /** Where a refusal goes. Defaults to stderr. */
  readonly reportFatal?: (line: string) => void
}

function defaultReport(line: string): void {
  process.stdout.write(`${line}\n`)
}

function defaultReportFatal(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Deletes the account with this address, or reports why it did not.
 *
 * Publishing happens after commit and is not awaited here. The caller drains
 * the event bus before it closes the database, or a subscriber such as the
 * cloud's directory release never runs.
 *
 * @returns The exit code a script should return: `ACCOUNT_DELETION_EXIT_DELETED`
 *   (0), `ACCOUNT_DELETION_EXIT_UNKNOWN` (2) or `ACCOUNT_DELETION_EXIT_REFUSED` (3).
 * @throws Whatever is not a refusal: a database fault, or a handler that
 *   failed rather than refused. Nothing was deleted.
 */
export async function runAccountDeletion(options: RunAccountDeletionOptions): Promise<number> {
  const report = options.report ?? defaultReport
  const reportFatal = options.reportFatal ?? defaultReportFatal
  const email = options.email.trim().toLowerCase()

  if (email.length === 0) {
    reportFatal('Give the address of the account to delete.')

    return ACCOUNT_DELETION_EXIT_UNKNOWN
  }

  const user = await repository.findUserByEmail(options.db, email)

  if (user === undefined) {
    reportFatal(`No account has the address ${email}. Nothing was deleted.`)

    return ACCOUNT_DELETION_EXIT_UNKNOWN
  }

  try {
    const deleted = await deleteAccountRecord(
      { transaction: options.transaction, runDeletionHandlers: options.runAccountDeletionHandlers },
      user.id,
      { actor: { kind: 'system' } },
    )

    if (deleted === undefined) {
      reportFatal(`The account with the address ${email} was deleted while this ran. Nothing more was deleted.`)

      return ACCOUNT_DELETION_EXIT_UNKNOWN
    }

    report(`Deleted account ${deleted.userId} (${deleted.email}).`)

    return ACCOUNT_DELETION_EXIT_DELETED
  } catch (error: unknown) {
    if (!(error instanceof AppError)) {
      throw error
    }

    reportFatal(`Refused: ${error.message}. Nothing was deleted.`)

    for (const detail of error.details ?? []) {
      reportFatal(`  ${detail.field}: ${detail.message}`)
    }

    return ACCOUNT_DELETION_EXIT_REFUSED
  }
}

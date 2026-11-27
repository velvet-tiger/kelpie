import type { EventActor } from '@kelpie/schemas'

import { isTransientTransactionFailure } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { AccountDeletion } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import * as rateLimitRepository from '../rate-limit/repository.ts'
import { ACCOUNT_DELETED_NOTICE } from './emailJobs.ts'
import * as repository from './repository.ts'

/**
 * Deleting an account: the part both paths share.
 *
 * The account deleting itself (`DELETE /v1/account`) and an operator deleting
 * it by address (`runAccountDeletion`) differ only in who is allowed to ask.
 * What happens next is the same, so it lives once, here.
 *
 * One transaction, in this order:
 *
 *   1. Lock the account row. Nothing can attach a new row to the account
 *      (a session, a membership) until the transaction ends, so what the
 *      handlers find is everything there is.
 *   2. Run every module's deletion handler. A refusal rolls everything back.
 *   3. Delete the rate-limit counters keyed on the address. They belong to no
 *      module, so no handler would.
 *   4. Queue the notice to the address. After the handlers, so a refusal
 *      queues nothing; on the transaction, so a rollback drops it.
 *   5. Delete the row. Sessions, tokens, preferences, OAuth connections and
 *      grants, personal API keys and memberships go by cascade.
 *   6. Emit `auth.user.deleted`, published after commit.
 *
 * The account row is locked before any workspace row a handler locks. Two
 * deletions therefore cannot wait on each other in a cycle, provided handlers
 * take workspace rows in a fixed order (the workspace module's sorts by id).
 * No path that holds a workspace row lock goes on to wait for an account row:
 * joining a workspace takes no workspace row lock, and the paths that do
 * (role changes, member removal) write only membership and record rows.
 *
 * A deadlock is still possible with work that locks a record before it names
 * the member: the member editing a deal they own locks the deal, then takes a
 * key-share lock on their member row to record the activity, while the
 * deletion holds that member row and waits for the deal. Postgres breaks the
 * cycle by aborting one side. When the deletion is the one aborted, it runs
 * again from the start: the rollback undid its writes and dropped its
 * buffered events, so a second run is the first run over again.
 */

/** How many times a deletion runs again after Postgres aborts it as transient. */
export const DELETION_RETRIES = 2

/** What a deletion answers when every run was aborted. The caller can try again. */
export const DELETION_CONTENDED_MESSAGE = 'The account changed while it was being deleted. Try again'

export interface AccountDeletionDependencies {
  readonly transaction: TransactionScope
  /** `ModuleContext.runAccountDeletionHandlers`, or the same runner from the contributions. */
  readonly runDeletionHandlers: (deletion: AccountDeletion) => Promise<void>
}

export interface DeleteAccountOptions {
  /** Who asked, for the event envelope: the account, or `system` for an operator. */
  readonly actor: EventActor
  /**
   * Checks the account as it stands under the row lock, and throws to refuse.
   * The self-service path uses it to confirm that the password it verified
   * before the transaction is still the account's.
   */
  readonly checkLocked?: (user: repository.UserRecord) => void
}

/** The account that went, as the event reported it. */
export interface DeletedAccount {
  readonly userId: string
  /** The address the account had, normalised the way it was stored. */
  readonly email: string
}

/**
 * @returns The deleted account, or undefined when there was no account with
 *   that id by the time the row lock was taken. Nothing was deleted then.
 * @throws AppError when `checkLocked` or a deletion handler refuses. Nothing
 *   is deleted.
 * @throws AppError `409` (`DELETION_CONTENDED_MESSAGE`) when Postgres aborted
 *   every run as a deadlock or a serialization conflict. Nothing is deleted.
 */
export async function deleteAccountRecord(
  dependencies: AccountDeletionDependencies,
  userId: string,
  options: DeleteAccountOptions,
): Promise<DeletedAccount | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deleteOnce(dependencies, userId, options)
    } catch (error: unknown) {
      if (!isTransientTransactionFailure(error)) {
        throw error
      }

      if (attempt >= DELETION_RETRIES) {
        throw AppError.conflict(DELETION_CONTENDED_MESSAGE)
      }
    }
  }
}

/** One run of the deletion transaction. */
async function deleteOnce(
  dependencies: AccountDeletionDependencies,
  userId: string,
  options: DeleteAccountOptions,
): Promise<DeletedAccount | undefined> {
  return dependencies.transaction(
    async (context) => {
      const user = await repository.findUserByIdForUpdate(context.tx, userId)

      if (user === undefined) {
        return undefined
      }

      options.checkLocked?.(user)

      await dependencies.runDeletionHandlers({ ...context, userId, email: user.email })
      await rateLimitRepository.deleteAddressBuckets(context.tx, user.email)
      // The row is gone when the job runs, so the payload carries the address.
      await context.jobs.enqueue(ACCOUNT_DELETED_NOTICE, { email: user.email })

      const deleted = await repository.deleteUser(context.tx, userId)

      // The row was read under a lock this transaction still holds, so it
      // cannot have gone in between. A miss here is a fault, not a race.
      if (deleted !== 1) {
        throw new Error(`Deleting account ${userId} removed ${String(deleted)} rows while holding its row lock`)
      }

      context.events.emitAccountEvent('auth.user.deleted', { type: 'user', id: userId }, {
        userId,
        email: user.email,
      })

      return { userId, email: user.email }
    },
    { actor: options.actor },
  )
}

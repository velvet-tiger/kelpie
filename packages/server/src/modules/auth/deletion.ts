import type { EventActor } from '@kelpie/schemas'

import type { AccountDeletion } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
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
 *   3. Delete the row. Sessions, tokens, preferences, OAuth connections and
 *      grants, personal API keys and memberships go by cascade.
 *   4. Emit `auth.user.deleted`, published after commit.
 *
 * The account row is locked before any workspace row a handler locks. Two
 * deletions therefore cannot wait on each other in a cycle, provided handlers
 * take workspace rows in a fixed order (the workspace module's sorts by id).
 * No path that holds a workspace row lock goes on to wait for an account row:
 * joining a workspace takes no workspace row lock, and the paths that do
 * (role changes, member removal) write only membership and record rows.
 */

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
 */
export async function deleteAccountRecord(
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

      await dependencies.runDeletionHandlers({ ...context, userId })

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

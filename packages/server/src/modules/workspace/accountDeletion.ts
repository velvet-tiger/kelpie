import { AppError } from '../../lib/errors.ts'
import type { ErrorDetail } from '../../lib/errors.ts'
import type { AccountDeletion } from '../../runtime/module.ts'
import { personActorKeys } from './idempotencyMiddleware.ts'
import { deleteIdempotencyKeysOfActors, listPersonalCredentialIds } from './idempotencyRepository.ts'
import * as repository from './repository.ts'
import type { MemberRecord } from './repository.ts'

/**
 * What membership does when an account is deleted. Registered as the
 * workspace module's account-deletion handler.
 *
 * An account that owns a workspace cannot go: the workspace would be left
 * with no owner, and nobody could administer it. The refusal names each
 * workspace, so the person knows where to give ownership away or which
 * workspace to delete first.
 *
 * Any other membership goes with the account. The records the member owned
 * or wrote stay, with nobody named: a person leaving is not a reason to take
 * a workspace's records, and not a reason to keep the person until somebody
 * reassigns them. Each membership publishes `workspace.member.removed`, the
 * same event an admin's removal publishes, so every subscriber that cleans up
 * after a member does so here too.
 *
 * The idempotency keys the person's own requests reserved go too: through
 * their session, their personal API keys and their OAuth connections. A
 * stored response can hold what they wrote, and nothing else would remove it.
 * The key and connection ids are read here, before the cascade takes them.
 *
 * The account row is already locked when this runs, so no membership can be
 * added while it does. Each workspace row is locked in workspace id order,
 * the order every deletion uses, and then the member row. The workspace lock
 * waits out a role change in flight: a member who is being made the owner is
 * read as the owner. The member lock stops anyone naming the member on a new
 * record before the row goes.
 */
export async function handleAccountDeletion(deletion: AccountDeletion): Promise<void> {
  const memberships = await repository.listAccountMemberships(deletion.tx, deletion.userId)
  const owned: ErrorDetail[] = []
  const leaving: MemberRecord[] = []

  for (const membership of memberships) {
    await repository.lockMembershipChanges(deletion.tx, membership.workspaceId)

    const member = await repository.findMemberForUpdate(deletion.tx, membership.memberId)

    // An admin removed it after the list was read. Nothing of it is left to clear.
    if (member === undefined) {
      continue
    }

    if (member.role === 'owner') {
      owned.push({ field: membership.workspaceId, message: membership.workspaceName })
    } else {
      leaving.push(member)
    }
  }

  if (owned.length > 0) {
    throw AppError.conflict(
      'This account owns a workspace. Give ownership to another member, or delete the workspace, first',
      owned,
    )
  }

  for (const member of leaving) {
    await repository.clearMemberReferences(deletion.tx, member.workspaceId, member.id)

    deletion.events.emit(
      'workspace.member.removed',
      { type: 'member', id: member.id },
      { userId: deletion.userId },
      { workspaceId: member.workspaceId },
    )
  }

  const credentials = await listPersonalCredentialIds(deletion.tx, deletion.userId)

  await deleteIdempotencyKeysOfActors(deletion.tx, personActorKeys(deletion.userId, credentials))
}

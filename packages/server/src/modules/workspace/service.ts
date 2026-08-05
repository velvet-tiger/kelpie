import { UNIQUE_VIOLATION, isReferenceViolation, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import type { EmailSender } from '../../lib/email.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { generateToken, hashToken } from '../../lib/tokens.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { limitFor } from '../../runtime/entitlements.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor, SessionActor } from '../auth/actor.ts'
import * as authRepository from '../auth/repository.ts'
import { SEATS_LIMIT } from './capabilities.ts'
import * as repository from './repository.ts'
import { parseInvitableRole, parseMemberRole, roleAllows } from './roles.ts'
import type { InvitableRole, InviteStatus, MemberRole } from './roles.ts'
import {
  STARTER_HANDBOOK_PAGES,
  STARTER_PIPELINE_STAGES,
  starterHandbookBody,
} from './starters.ts'

/**
 * Workspaces and who belongs to them.
 *
 * Creating a workspace is the only place a member row appears without an invite,
 * and it is what turns a bare account into something that can hold data.
 */

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export interface WorkspaceDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly email: EmailSender
  readonly createId: IdFactory
  readonly now: () => Date
  readonly entitlements: EntitlementRegistry
  readonly newToken?: () => string
}

export interface WorkspaceView {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly tagline: string | null
  readonly oneLiner: string | null
}

export interface MemberView {
  readonly id: string
  readonly userId: string
  readonly role: MemberRole
  readonly joinedAt: Date
  readonly name: string
  readonly email: string
}

export interface InviteView {
  readonly id: string
  readonly email: string
  readonly role: InvitableRole
  readonly status: InviteStatus
  readonly expiresAt: Date
  readonly createdAt: Date
}

export interface CreateWorkspaceInput {
  readonly name: string
  readonly slug: string
  readonly timezone: string
}

export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly slug?: string
  readonly timezone?: string
  readonly tagline?: string | null
  readonly oneLiner?: string | null
}

export interface WorkspaceService {
  /** Creates the workspace, makes the caller its owner, and seeds its starters. */
  create(actor: SessionActor, input: CreateWorkspaceInput): Promise<WorkspaceView>
  get(actor: Actor, workspaceId: string): Promise<WorkspaceView>
  update(actor: Actor, workspaceId: string, changes: UpdateWorkspaceInput): Promise<WorkspaceView>
  /**
   * Deletes the workspace and everything in it.
   *
   * @param confirmSlug The workspace's own slug. The caller has to name what it
   *   is destroying, so an unintended `DELETE` at the right id does nothing.
   */
  remove(actor: Actor, workspaceId: string, confirmSlug: string): Promise<void>
  listMembers(actor: Actor, workspaceId: string): Promise<readonly MemberView[]>
  /** Changes a member's role, or transfers ownership when `role` is `owner`. */
  setMemberRole(actor: Actor, workspaceId: string, memberId: string, role: MemberRole): Promise<MemberView>
  removeMember(actor: Actor, workspaceId: string, memberId: string): Promise<void>
  invite(actor: Actor, workspaceId: string, email: string, role: InvitableRole, urlTemplate: string): Promise<InviteView>
  listInvites(actor: Actor, workspaceId: string): Promise<readonly InviteView[]>
  /** Issues a fresh token and expiry for an invitation, and emails it again. */
  resendInvite(actor: Actor, workspaceId: string, inviteId: string, urlTemplate: string): Promise<InviteView>
  revokeInvite(actor: Actor, workspaceId: string, inviteId: string): Promise<void>
  /** Joins the invited workspace as the calling account. */
  acceptInvite(actor: SessionActor, token: string): Promise<WorkspaceView>
}

function toWorkspaceView(record: repository.WorkspaceRecord): WorkspaceView {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    timezone: record.timezone,
    tagline: record.tagline,
    oneLiner: record.oneLiner,
  }
}

/**
 * An invitation as a reader sees it.
 *
 * `status` is computed from `expires_at` rather than read from the column.
 * Expiry is a function of the clock, so a stored value would only be true until
 * the moment it passed, and keeping it true would mean a sweeper. `acceptInvite`
 * already decides the same way, and this keeps the list agreeing with it.
 */
function toInviteView(record: repository.InviteRecord, now: Date): InviteView {
  const role = parseInvitableRole(record.role)

  if (role === undefined) {
    throw new Error(`invites.role holds "${record.role}", which its check constraint forbids`)
  }

  return {
    id: record.id,
    email: record.email,
    role,
    status: record.expiresAt > now ? 'pending' : 'expired',
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  }
}

function toMemberView(record: repository.MemberWithUser): MemberView {
  const role = parseMemberRole(record.role)

  if (role === undefined) {
    throw new Error(`workspace_members.role holds "${record.role}", which its check forbids`)
  }

  return {
    id: record.id,
    userId: record.userId,
    role,
    joinedAt: record.joinedAt,
    name: record.name,
    email: record.email,
  }
}

export function createWorkspaceService(dependencies: WorkspaceDependencies): WorkspaceService {
  const newToken = dependencies.newToken ?? generateToken

  /**
   * A workspace the actor does not belong to is indistinguishable from one that
   * does not exist, per `api.md`.
   *
   * A workspace key has no member row: it is bound to its workspace at creation,
   * and that binding is the membership. `memberId` is null for it, so anything
   * needing a member to attribute the action to must say so.
   */
  async function requireMembership(
    actor: Actor,
    workspaceId: string,
    required: MemberRole,
  ): Promise<{ memberId: string | null; role: MemberRole }> {
    if (actor.kind === 'api_key') {
      if (actor.workspaceId !== workspaceId) {
        throw AppError.notFound('Workspace not found')
      }

      if (actor.userId === null) {
        if (!roleAllows(actor.role, required)) {
          throw new AppError('forbidden', `This action needs the ${required} role`)
        }

        return { memberId: null, role: actor.role }
      }

      return membershipFor(actor.userId, workspaceId, required)
    }

    return membershipFor(actor.userId, workspaceId, required)
  }

  async function membershipFor(
    userId: string,
    workspaceId: string,
    required: MemberRole,
  ): Promise<{ memberId: string; role: MemberRole }> {
    const membership = await authRepository.findMembership(dependencies.db, workspaceId, userId)

    if (membership === undefined) {
      throw AppError.notFound('Workspace not found')
    }

    const role = parseMemberRole(membership.role)

    if (role === undefined) {
      throw new Error(`workspace_members.role holds "${membership.role}", which its check forbids`)
    }

    if (!roleAllows(role, required)) {
      throw new AppError('forbidden', `This action needs the ${required} role`)
    }

    return { memberId: membership.id, role }
  }

  /**
   * Refuses a new invitation once the workspace is at its seat limit.
   *
   * Open source has no grant provider, so the limit is null and this never
   * refuses. The cloud billing module is what makes it bite.
   */
  async function requireSeat(workspaceId: string): Promise<void> {
    const limit = await limitFor(dependencies.entitlements, workspaceId, SEATS_LIMIT.name)

    if (limit === null) {
      return
    }

    const inUse = await repository.countSeatsInUse(dependencies.db, workspaceId, dependencies.now())

    if (inUse >= limit) {
      throw new AppError(
        'entitlement_required',
        `This workspace has ${String(limit)} seats and all of them are taken`,
      )
    }
  }

  /**
   * Refuses an address that already belongs to a member of this workspace.
   *
   * The question has to be asked through `users`, because membership is held by
   * account and an account is identified by its address; `invites` has never met
   * the member. Without this the Team page lists one person twice, once as a
   * member and once as an invitation whose emailed link works right up until an
   * accept that can only ever fail.
   */
  async function requireStranger(workspaceId: string, address: string): Promise<void> {
    const user = await authRepository.findUserByEmail(dependencies.db, address)

    if (user === undefined) {
      return
    }

    const membership = await authRepository.findMembership(dependencies.db, workspaceId, user.id)

    if (membership !== undefined) {
      throw AppError.conflict('That address already belongs to a member of this workspace', [
        { field: 'email', message: 'Already a member' },
      ])
    }
  }

  /**
   * The membership being acted on.
   *
   * A member of another workspace is not found rather than forbidden, for the
   * same reason `api.md` gives for records: an id that answers differently when
   * it exists elsewhere tells the caller it exists elsewhere.
   */
  async function requireTarget(workspaceId: string, memberId: string): Promise<repository.MemberRecord> {
    const target = await repository.findMember(dependencies.db, workspaceId, memberId)

    if (target === undefined) {
      throw AppError.notFound('Member not found')
    }

    return target
  }

  function sendInviteEmail(to: string, token: string, urlTemplate: string): Promise<void> {
    return dependencies.email.send({
      to,
      subject: 'You have been invited to a Kelpie workspace',
      body: `Accept the invitation within seven days:\n\n${urlTemplate.replace('{token}', token)}`,
    })
  }

  /** The same membership with the name and email a reader needs, after a write. */
  async function requireMemberWithUser(
    workspaceId: string,
    memberId: string,
  ): Promise<repository.MemberWithUser> {
    const member = await repository.findMemberWithUser(dependencies.db, workspaceId, memberId)

    if (member === undefined) {
      throw new Error(`Member ${memberId} has no user row, which the join makes impossible`)
    }

    return member
  }

  async function requireInvite(workspaceId: string, inviteId: string): Promise<repository.InviteRecord> {
    const invite = await repository.findInvite(dependencies.db, workspaceId, inviteId)

    if (invite === undefined) {
      throw AppError.notFound('Invitation not found')
    }

    return invite
  }

  /**
   * Moves ownership to `target` and leaves the outgoing owner an admin.
   *
   * One transaction, because a workspace with two owners or none is a state no
   * other code is written to survive.
   */
  async function transferOwnership(
    workspaceId: string,
    currentOwner: repository.MemberRecord,
    target: repository.MemberRecord,
  ): Promise<repository.MemberWithUser> {
    const now = dependencies.now()

    return dependencies.transaction(async ({ tx }) => {
      await repository.updateMemberRole(tx, currentOwner.id, 'admin', now)
      await repository.updateMemberRole(tx, target.id, 'owner', now)

      const updated = await repository.findMemberWithUser(tx, workspaceId, target.id)

      if (updated === undefined) {
        throw new Error(`Member ${target.id} vanished during an ownership transfer`)
      }

      return updated
    })
  }

  return {
    async create(actor, input) {
      const now = dependencies.now()
      const workspaceId = dependencies.createId('workspace')
      const memberId = dependencies.createId('teamMember')

      return dependencies.transaction(async ({ tx, events }) => {
        let workspace: repository.WorkspaceRecord

        try {
          workspace = await repository.insertWorkspace(tx, {
            id: workspaceId,
            name: input.name,
            slug: input.slug,
            timezone: input.timezone,
          })
        } catch (error: unknown) {
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw AppError.conflict('That workspace address is taken', [
              { field: 'slug', message: 'Already in use' },
            ])
          }

          throw error
        }

        await repository.insertMember(tx, {
          id: memberId,
          workspaceId,
          userId: actor.userId,
          role: 'owner',
          joinedAt: now,
        })

        await repository.insertHandbookPages(
          tx,
          STARTER_HANDBOOK_PAGES.map((page, index) => ({
            id: dependencies.createId('handbookPage'),
            workspaceId,
            title: page.title,
            slug: page.slug,
            sortOrder: index,
            body: starterHandbookBody(page.title),
            updatedBy: memberId,
          })),
        )

        await repository.insertPipelineStages(
          tx,
          Object.entries(STARTER_PIPELINE_STAGES).flatMap(([kind, stages]) =>
            stages.map((stage, index) => ({
              id: dependencies.createId('pipelineStage'),
              workspaceId,
              kind,
              slug: stage.slug,
              label: stage.label,
              open: stage.open,
              sortOrder: index,
            })),
          ),
        )

        // The session that created the workspace should land in it.
        await authRepository.setActiveWorkspace(tx, actor.sessionId, workspaceId)

        events.emit('workspace.created', { workspaceId, slug: workspace.slug })
        events.emit('member.joined', { workspaceId, memberId, userId: actor.userId })

        return toWorkspaceView(workspace)
      })
    },

    async get(actor, workspaceId) {
      await requireMembership(actor, workspaceId, 'member')
      const workspace = await repository.findWorkspace(dependencies.db, workspaceId)

      if (workspace === undefined) {
        throw AppError.notFound('Workspace not found')
      }

      return toWorkspaceView(workspace)
    },

    async update(actor, workspaceId, changes) {
      await requireMembership(actor, workspaceId, 'admin')

      let updated: repository.WorkspaceRecord | undefined

      try {
        updated = await repository.updateWorkspace(dependencies.db, workspaceId, {
          ...changes,
          updatedAt: dependencies.now(),
        })
      } catch (error: unknown) {
        if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
          throw AppError.conflict('That workspace address is taken', [
            { field: 'slug', message: 'Already in use' },
          ])
        }

        throw error
      }

      if (updated === undefined) {
        throw AppError.notFound('Workspace not found')
      }

      return toWorkspaceView(updated)
    },

    async remove(actor, workspaceId, confirmSlug) {
      // Owner only. A workspace key resolves as an admin and can never reach
      // this, which is deliberate: an agent's credential does not get to end the
      // workspace it lives in.
      await requireMembership(actor, workspaceId, 'owner')

      const workspace = await repository.findWorkspace(dependencies.db, workspaceId)

      if (workspace === undefined) {
        throw AppError.notFound('Workspace not found')
      }

      if (confirmSlug !== workspace.slug) {
        throw AppError.validationFailed('Confirm the deletion by naming the workspace', [
          { field: 'slug', message: `Expected "${workspace.slug}"` },
        ])
      }

      await dependencies.transaction(async ({ tx, events }) => {
        await repository.deleteWorkspace(tx, workspaceId)

        events.emit('workspace.deleted', { workspaceId, slug: workspace.slug })
      })
    },

    async listMembers(actor, workspaceId) {
      await requireMembership(actor, workspaceId, 'member')
      const records = await repository.listMembers(dependencies.db, workspaceId)

      return records.map(toMemberView)
    },

    async setMemberRole(actor, workspaceId, memberId, role) {
      const caller = await requireMembership(actor, workspaceId, 'admin')
      const target = await requireTarget(workspaceId, memberId)

      if (role === 'owner') {
        if (caller.role !== 'owner') {
          throw new AppError('forbidden', 'Only the owner can hand ownership to somebody else')
        }

        const currentOwner = await repository.findOwner(dependencies.db, workspaceId)

        if (currentOwner === undefined) {
          throw new Error(`Workspace ${workspaceId} has an owner-role caller but no owner row`)
        }

        if (currentOwner.id === target.id) {
          return toMemberView(await requireMemberWithUser(workspaceId, target.id))
        }

        return toMemberView(await transferOwnership(workspaceId, currentOwner, target))
      }

      // Demoting the owner by naming their row would leave the workspace without
      // one. Transferring is the only way ownership moves, and it fills the seat
      // in the same write that empties it.
      if (target.role === 'owner') {
        throw AppError.conflict(
          'The owner cannot be demoted. Give ownership to another member instead',
        )
      }

      await repository.updateMemberRole(dependencies.db, target.id, role, dependencies.now())

      return toMemberView(await requireMemberWithUser(workspaceId, target.id))
    },

    async removeMember(actor, workspaceId, memberId) {
      await requireMembership(actor, workspaceId, 'admin')
      const target = await requireTarget(workspaceId, memberId)

      if (target.role === 'owner') {
        throw AppError.conflict(
          'The owner cannot be removed. Give ownership to another member first',
        )
      }

      // `schema.md`: removing a member is restricted while they own records.
      // Reported before the delete so every referencing type can be named, which
      // is what the caller needs to know what to reassign.
      const references = await repository.countMemberReferences(dependencies.db, target.id)

      if (references.length > 0) {
        throw AppError.conflict(
          'This member still owns records. Reassign them first',
          references.map((reference) => ({
            field: reference.type,
            message: `Owns ${String(reference.count)}`,
          })),
        )
      }

      try {
        await dependencies.transaction(async ({ tx, events }) => {
          await repository.deleteMember(tx, target.id)

          events.emit('member.removed', { workspaceId, memberId: target.id, userId: target.userId })
        })
      } catch (error: unknown) {
        // A record assigned to them between the count and this delete. The
        // constraint answers the same question the count did, so the caller gets
        // the same refusal rather than a 500; it just cannot name the type.
        if (isReferenceViolation(error)) {
          throw AppError.conflict('This member owns records that were assigned while removing them')
        }

        throw error
      }
    },

    async invite(actor, workspaceId, email, role, urlTemplate) {
      const inviter = await requireMembership(actor, workspaceId, 'admin')
      const address = email.trim().toLowerCase()
      const now = dependencies.now()

      // Both refusals come before the seat check, so an address that could never
      // be invited is told that rather than told the workspace is full.
      await requireStranger(workspaceId, address)

      const existing = await repository.listInvitesForEmail(dependencies.db, workspaceId, address)

      // Open, not merely present: an expired invitation cannot be accepted, so
      // refusing on one would leave an address permanently un-invitable by
      // anyone who did not think to look for the Resend button.
      if (existing.some((invitation) => invitation.expiresAt > now)) {
        throw AppError.conflict('That address has already been invited to this workspace', [
          { field: 'email', message: 'Already invited' },
        ])
      }

      await requireSeat(workspaceId)

      const token = newToken()
      const invite = await dependencies.transaction(async ({ tx, events }) => {
        // The expired invitations this one replaces. Kept to one row per address
        // so the list never shows the same person twice, which is the confusion
        // the guards above exist to remove.
        if (existing.length > 0) {
          await repository.deleteInvitesForEmail(tx, workspaceId, address)
        }

        const created = await repository.insertInvite(tx, {
          id: dependencies.createId('invite'),
          workspaceId,
          email: address,
          role,
          invitedBy: inviter.memberId,
          status: 'pending',
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
        })

        events.emit('member.invited', { workspaceId, inviteId: created.id, email: created.email })

        return created
      })

      // Sent after commit, so a rolled-back invite never reaches an inbox.
      await sendInviteEmail(invite.email, token, urlTemplate)

      return toInviteView(invite, now)
    },

    async listInvites(actor, workspaceId) {
      await requireMembership(actor, workspaceId, 'admin')
      const records = await repository.listInvites(dependencies.db, workspaceId)
      const now = dependencies.now()

      return records.map((record) => toInviteView(record, now))
    },

    async resendInvite(actor, workspaceId, inviteId, urlTemplate) {
      await requireMembership(actor, workspaceId, 'admin')
      const invite = await requireInvite(workspaceId, inviteId)

      // A new token, not the old one again: the address in the first email may
      // have been forwarded anywhere, and reissuing retires it.
      const now = dependencies.now()
      const token = newToken()
      const updated = await repository.updateInvite(dependencies.db, invite.id, {
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
        status: 'pending',
        updatedAt: now,
      })

      if (updated === undefined) {
        throw AppError.notFound('Invitation not found')
      }

      await sendInviteEmail(updated.email, token, urlTemplate)

      return toInviteView(updated, now)
    },

    async revokeInvite(actor, workspaceId, inviteId) {
      await requireMembership(actor, workspaceId, 'admin')
      const invite = await requireInvite(workspaceId, inviteId)

      // Deleted rather than marked: the row is what the token resolves through,
      // so removing it is what actually stops the link in the sent email.
      await repository.deleteInvite(dependencies.db, invite.id)
    },

    async acceptInvite(actor, token) {
      const now = dependencies.now()
      const invite = await repository.findInviteByTokenHash(dependencies.db, hashToken(token))

      if (invite === undefined || invite.status !== 'pending' || invite.expiresAt <= now) {
        throw AppError.unauthorized('That invitation is invalid or has expired')
      }

      const existing = await authRepository.findMembership(
        dependencies.db,
        invite.workspaceId,
        actor.userId,
      )

      // The invitation is left alone. A link is forwarded often enough that the
      // address on this one may not be the caller's, and revoking somebody
      // else's invitation because you clicked their link would be worse than
      // the refusal.
      if (existing !== undefined) {
        throw AppError.conflict('You already belong to that workspace')
      }

      const joiner = await authRepository.findUserById(dependencies.db, actor.userId)

      if (joiner === undefined) {
        throw new Error(`Session ${actor.sessionId} outlived the user row behind it`)
      }

      // Ownership is never invited, only created or transferred. The column's
      // check constraint says the same; this is the service-side half of it.
      const role: MemberRole = invite.role === 'admin' ? 'admin' : 'member'
      const memberId = dependencies.createId('teamMember')

      return dependencies.transaction(async ({ tx, events }) => {
        try {
          await repository.insertMember(tx, {
            id: memberId,
            workspaceId: invite.workspaceId,
            userId: actor.userId,
            role,
            joinedAt: now,
          })
        } catch (error: unknown) {
          // The membership check above answers this for every caller who is not
          // racing a second accept of their own. This is what catches that one.
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw AppError.conflict('You already belong to that workspace')
          }

          throw error
        }

        await repository.deleteInvite(tx, invite.id)

        // Any other invitation to the joiner's own address, which their joining
        // has just killed: accepting one is now the refusal above, and until it
        // expires it holds a seat and lists them beside their own membership.
        // Accepting a token addressed to somebody else is how one survives the
        // line before it.
        await repository.deleteInvitesForEmail(tx, invite.workspaceId, joiner.email)

        await authRepository.setActiveWorkspace(tx, actor.sessionId, invite.workspaceId)

        const workspace = await repository.findWorkspace(tx, invite.workspaceId)

        if (workspace === undefined) {
          throw AppError.notFound('Workspace not found')
        }

        events.emit('member.joined', {
          workspaceId: invite.workspaceId,
          memberId,
          userId: actor.userId,
        })

        return toWorkspaceView(workspace)
      })
    },
  }
}

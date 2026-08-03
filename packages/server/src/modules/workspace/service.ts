import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
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
import { parseMemberRole, roleAllows } from './roles.ts'
import type { InvitableRole, MemberRole } from './roles.ts'
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
  readonly role: string
  readonly status: string
  readonly expiresAt: Date
}

export interface CreateWorkspaceInput {
  readonly name: string
  readonly slug: string
  readonly timezone: string
}

export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly timezone?: string
  readonly tagline?: string | null
  readonly oneLiner?: string | null
}

export interface WorkspaceService {
  /** Creates the workspace, makes the caller its owner, and seeds its starters. */
  create(actor: SessionActor, input: CreateWorkspaceInput): Promise<WorkspaceView>
  get(actor: Actor, workspaceId: string): Promise<WorkspaceView>
  update(actor: Actor, workspaceId: string, changes: UpdateWorkspaceInput): Promise<WorkspaceView>
  listMembers(actor: Actor, workspaceId: string): Promise<readonly MemberView[]>
  invite(actor: Actor, workspaceId: string, email: string, role: InvitableRole, urlTemplate: string): Promise<InviteView>
  listInvites(actor: Actor, workspaceId: string): Promise<readonly InviteView[]>
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

function toInviteView(record: repository.InviteRecord): InviteView {
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    status: record.status,
    expiresAt: record.expiresAt,
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

    const inUse = await repository.countSeatsInUse(dependencies.db, workspaceId)

    if (inUse >= limit) {
      throw new AppError(
        'entitlement_required',
        `This workspace has ${String(limit)} seats and all of them are taken`,
      )
    }
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

      const updated = await repository.updateWorkspace(dependencies.db, workspaceId, {
        ...changes,
        updatedAt: dependencies.now(),
      })

      if (updated === undefined) {
        throw AppError.notFound('Workspace not found')
      }

      return toWorkspaceView(updated)
    },

    async listMembers(actor, workspaceId) {
      await requireMembership(actor, workspaceId, 'member')
      const records = await repository.listMembers(dependencies.db, workspaceId)

      return records.map((record) => {
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
      })
    },

    async invite(actor, workspaceId, email, role, urlTemplate) {
      const inviter = await requireMembership(actor, workspaceId, 'admin')

      await requireSeat(workspaceId)

      const now = dependencies.now()
      const token = newToken()
      const invite = await dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertInvite(tx, {
          id: dependencies.createId('invite'),
          workspaceId,
          email: email.trim().toLowerCase(),
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
      await dependencies.email.send({
        to: invite.email,
        subject: 'You have been invited to a Kelpie workspace',
        body: `Accept the invitation within seven days:\n\n${urlTemplate.replace('{token}', token)}`,
      })

      return toInviteView(invite)
    },

    async listInvites(actor, workspaceId) {
      await requireMembership(actor, workspaceId, 'admin')
      const records = await repository.listInvites(dependencies.db, workspaceId)

      return records.map(toInviteView)
    },

    async acceptInvite(actor, token) {
      const now = dependencies.now()
      const invite = await repository.findInviteByTokenHash(dependencies.db, hashToken(token))

      if (invite === undefined || invite.status !== 'pending' || invite.expiresAt <= now) {
        throw AppError.unauthorized('That invitation is invalid or has expired')
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
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw AppError.conflict('You are already a member of that workspace')
          }

          throw error
        }

        await repository.deleteInvite(tx, invite.id)
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

import { z } from 'zod'

import { requireWorkspaceId } from '../../lib/actor.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { deleteResult, idArg } from '../crudTools.ts'
import { inviteBody, inviteResponse, memberResponse, memberRoleBody, resendBody, updateBody, workspaceResponse } from './routes.ts'
import type { WorkspaceService } from './service.ts'

/**
 * `workspace_*`: settings, the team, and invitations.
 *
 * No workspace id argument anywhere. `api.md` makes the workspace implicit, a key
 * is bound to one at creation, and `/v1/workspaces/{id}` carries the id only
 * because a path needs a subject. Taking one here would offer a caller a choice
 * it does not have.
 *
 * Three REST operations have no tool. Creating a workspace and accepting an
 * invitation both need a browser session, which this endpoint does not take, and
 * a key issued for one workspace could not act on the new one anyway. Deleting a
 * workspace destroys everything the calling key is scoped to, and asking an agent
 * to confirm a slug is not a safeguard when the agent can read the slug.
 */

const noArgs = z.strictObject({})

export function registerWorkspaceTools(mcp: McpToolRegistry, service: WorkspaceService): void {
  mcp.tool({
    name: 'workspace_get',
    description:
      'This workspace\'s name, slug, timezone, tagline and one-liner. Mirrors GET /v1/workspaces/{id}.',
    inputSchema: noArgs,
    invoke: async (_args, actor) =>
      workspaceResponse(await service.get(actor, requireWorkspaceId(actor))),
  })

  mcp.tool({
    name: 'workspace_update',
    description:
      'Change this workspace\'s settings. Admin only. Mirrors PATCH /v1/workspaces/{id}.',
    inputSchema: updateBody,
    invoke: async (changes, actor) =>
      workspaceResponse(await service.update(actor, requireWorkspaceId(actor), changes)),
  })

  mcp.tool({
    name: 'workspace_members_list',
    description:
      'Everyone on this workspace, with their role. Use a member id here as the owner_id on a ' +
      'deal or a plan item. Mirrors GET /v1/workspaces/{id}/members.',
    inputSchema: noArgs,
    invoke: async (_args, actor) => ({
      data: (await service.listMembers(actor, requireWorkspaceId(actor))).map(memberResponse),
      next_cursor: null,
    }),
  })

  mcp.tool({
    name: 'workspace_members_set_role',
    description:
      'Change a member\'s role. Setting owner transfers ownership, which is a single seat. ' +
      'Admin only. Mirrors PATCH /v1/workspaces/{id}/members/{memberId}.',
    inputSchema: memberRoleBody.extend({ member_id: idArg }),
    invoke: async (args, actor) =>
      memberResponse(
        await service.setMemberRole(actor, requireWorkspaceId(actor), args.member_id, args.role),
      ),
  })

  mcp.tool({
    name: 'workspace_members_remove',
    description:
      'Remove somebody from this workspace. Admin only. ' +
      'Mirrors DELETE /v1/workspaces/{id}/members/{memberId}.',
    inputSchema: z.strictObject({ member_id: idArg }),
    invoke: async ({ member_id: memberId }, actor) => {
      await service.removeMember(actor, requireWorkspaceId(actor), memberId)

      return deleteResult(memberId)
    },
  })

  mcp.tool({
    name: 'workspace_invites_create',
    description:
      'Invite somebody by email and send them the invitation. invite_url_template is the page ' +
      'that accepts it and must contain {token}. Admin only. ' +
      'Mirrors POST /v1/workspaces/{id}/invites.',
    inputSchema: inviteBody,
    invoke: async (body, actor) =>
      inviteResponse(
        await service.invite(
          actor,
          requireWorkspaceId(actor),
          body.email,
          body.role,
          body.invite_url_template,
        ),
      ),
  })

  mcp.tool({
    name: 'workspace_invites_list',
    description:
      'Outstanding and spent invitations. Mirrors GET /v1/workspaces/{id}/invites.',
    inputSchema: noArgs,
    invoke: async (_args, actor) => ({
      data: (await service.listInvites(actor, requireWorkspaceId(actor))).map(inviteResponse),
      next_cursor: null,
    }),
  })

  mcp.tool({
    name: 'workspace_invites_resend',
    description:
      'Issue a fresh token and expiry for an invitation and email it again. Admin only. ' +
      'Mirrors POST /v1/workspaces/{id}/invites/{inviteId}/resend.',
    inputSchema: resendBody.extend({ invite_id: idArg }),
    invoke: async (args, actor) =>
      inviteResponse(
        await service.resendInvite(
          actor,
          requireWorkspaceId(actor),
          args.invite_id,
          args.invite_url_template,
        ),
      ),
  })

  mcp.tool({
    name: 'workspace_invites_revoke',
    description:
      'Withdraw an invitation that has not been accepted. Admin only. ' +
      'Mirrors DELETE /v1/workspaces/{id}/invites/{inviteId}.',
    inputSchema: z.strictObject({ invite_id: idArg }),
    invoke: async ({ invite_id: inviteId }, actor) => {
      await service.revokeInvite(actor, requireWorkspaceId(actor), inviteId)

      return deleteResult(inviteId)
    },
  })
}

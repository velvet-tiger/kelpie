import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the workspace module.
 *
 * Workspace-level events (`workspace.workspace.*`) target the workspace itself.
 * Membership events target the `workspace_members` row, with the user id in
 * `data` so a consumer that watches identity does not need a second lookup.
 */

export const workspaceEvents = {
  'workspace.workspace.created': z.object({ slug: z.string() }),
  'workspace.workspace.deleted': z.object({ slug: z.string() }),
  'workspace.member.invited': z.object({ inviteId: z.string(), email: z.string() }),
  'workspace.member.joined': z.object({ userId: z.string() }),
  'workspace.member.removed': z.object({ userId: z.string() }),
} satisfies ModuleEventCatalog

export interface WorkspaceCreatedData {
  readonly slug: string
}
export interface WorkspaceDeletedData {
  readonly slug: string
}
export interface MemberInvitedData {
  readonly inviteId: string
  readonly email: string
}
export interface MemberJoinedData {
  readonly userId: string
}
export interface MemberRemovedData {
  readonly userId: string
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'workspace.workspace.created': WorkspaceCreatedData
    'workspace.workspace.deleted': WorkspaceDeletedData
    'workspace.member.invited': MemberInvitedData
    'workspace.member.joined': MemberJoinedData
    'workspace.member.removed': MemberRemovedData
  }
}

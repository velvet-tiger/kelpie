import type { MemberRole } from '../workspace/roles.ts'

/**
 * Who is making a request. Resolved by the auth middleware and passed explicitly
 * to services; nothing reads auth state from a global.
 *
 * `workspaceId` is null between signup and the first workspace create. Anything
 * workspace-scoped must refuse that actor rather than guess.
 */
export interface Actor {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
}

/** An actor known to be inside a workspace, so services can stop re-checking. */
export interface WorkspaceActor extends Actor {
  readonly workspaceId: string
  readonly role: MemberRole
}

export function hasWorkspace(actor: Actor): actor is WorkspaceActor {
  return actor.workspaceId !== null && actor.role !== null
}

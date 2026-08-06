/**
 * The actor a module reads its caller through.
 *
 * The definitions moved to `lib/actor.ts` so the module runtime can name the type
 * without importing a feature module: an MCP tool is handed its caller exactly as
 * a route handler is (`runtime/module.ts`). Auth remains where an actor is
 * resolved from credentials, which is why modules still import it from here.
 */

export {
  actorMemberId,
  actorUserId,
  actorWorkspaceId,
  requireSessionActor,
  requireWorkspaceId,
} from '../../lib/actor.ts'
export type { Actor, ApiKeyActor, SessionActor } from '../../lib/actor.ts'

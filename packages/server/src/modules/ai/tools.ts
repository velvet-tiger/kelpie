import { createHostedAiActor } from '../auth/actor.ts'
import type { Actor } from '../auth/actor.ts'

/**
 * The synthetic actor a Kelpie AI run acts as.
 *
 * The executor calls other modules' MCP tools in-process, reading the list
 * through `context.mcp.list()` at run time, and every tool call needs an
 * actor. The shape is a workspace API key with the admin role, and no row in
 * `api_keys` stands behind it.
 *
 * The actor carries a mark that only `createHostedAiActor` can set. The notes
 * and decisions services read it to record a write as `origin: 'ai'`, and to
 * leave a Decision from a run unconfirmed.
 */
export function aiActorFor(workspaceId: string): Actor {
  return createHostedAiActor(workspaceId)
}

import type { Actor } from '../auth/actor.ts'

/**
 * The synthetic actor a Kelpie AI run acts as.
 *
 * The executor calls other modules' MCP tools in-process, reading the list
 * through `context.mcp.list()` at run time, and every tool call needs an
 * actor. Constructing one is safe: `Actor.apiKeyId` is only used for
 * rate-limit keying, never checked against a real row at invoke time. The
 * shape is a workspace API key with the admin role.
 */
export function aiActorFor(workspaceId: string): Actor {
  return {
    kind: 'api_key',
    // Not looked up in `api_keys`. Only `rate-limit` reads this field, keyed
    // per string; a stable per-workspace value gives every AI run for a
    // workspace one bucket, which is exactly the shape we want.
    apiKeyId: `apik_ai_${workspaceId}`,
    userId: null,
    workspaceId,
    role: 'admin',
    scopes: [],
    memberId: null,
  }
}

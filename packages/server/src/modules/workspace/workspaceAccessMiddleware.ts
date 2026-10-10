import type { Context, MiddlewareHandler } from 'hono'
import { tryDecodeURIComponent } from 'hono/utils/url'

import { AppError } from '../../lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX } from '../../lib/http.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import * as authRepository from '../auth/repository.ts'
import { WORKSPACE_ACCESS } from './capabilities.ts'

/**
 * `POST /v1/*` and every `/mcp` call carry a fixed workspace for the whole
 * request (`docs/agents/api-and-webhooks.md`): a session or key resolves to one
 * `Actor.workspaceId`, and every query it makes is scoped to that workspace
 * server-side. This blocks the request outright when that workspace's
 * `workspace.access` entitlement is not granted — inert in a self-hosted
 * assembly, since nothing registers a `GrantProvider` that answers it there
 * (`capabilities.ts`).
 *
 * Mounted the same way as `createIdempotencyMiddleware`: tolerates the
 * no-credential case, since an unauthenticated `/v1/auth/*` call has
 * nothing to check, and ahead of idempotency in `app.ts` so a blocked
 * request never reserves a key it will not be allowed to spend.
 *
 * A path can name a workspace itself: `/v1/workspaces/:id` and everything
 * under it. A session reaches each workspace its user belongs to through
 * those paths, whichever one is active, so the workspace this checks there is
 * the one in the path. See `gatedWorkspaceId`.
 *
 * `/v1/public/*` is not checked here. A public request acts on the workspace
 * its path names and on nobody's session, and its refusal must come after the
 * public CORS layer. `createPublicWorkspaceAccessMiddleware` checks it.
 *
 * Exempts `/v1/auth/*` and `/v1/account*`: they manage the *account*, not
 * the workspace, and a member of a workspace this gate has locked out
 * still needs to sign in, sign out, see their own account, list the
 * workspaces they belong to (`GET /v1/auth/workspaces`), and switch this
 * session to a different membership (`POST /v1/auth/workspace`).
 *
 * Also exempts `DELETE /v1/workspaces/:id` itself, and only that exact
 * path: a suspension must never trap an owner into a workspace they can no
 * longer read or write but also cannot leave by deleting. Every other verb
 * and every sub-resource under `/v1/workspaces/:id` (members, invites,
 * modules) stays gated.
 */
const WORKSPACE_DELETE_PATH = /^\/v1\/workspaces\/[^/]+$/u

function isExempt(method: string, path: string): boolean {
  // `/v1/oauth/` is the consent page and the connected apps list: account
  // pages in all but path, which a person must reach whatever the state of
  // their active workspace. A grant for a suspended workspace is refused at
  // `/mcp`, where the gate runs again.
  return path.startsWith('/v1/auth/') || path.startsWith('/v1/account') || path.startsWith('/v1/oauth/') ||
    (method === 'DELETE' && WORKSPACE_DELETE_PATH.test(path))
}

const WORKSPACE_PATH = /^\/v1\/workspaces\/([^/]+)/u
const PUBLIC_WORKSPACE_PATH = /^\/v1\/public\/workspaces\/([^/]+)/u

function isPublic(path: string): boolean {
  return path === PUBLIC_ROUTE_PREFIX || path.startsWith(`${PUBLIC_ROUTE_PREFIX}/`)
}

/**
 * The workspace id a path names, as the handler will read it.
 *
 * Decoded with the function the router uses for a path parameter. A different
 * decoder would let an encoded id name one workspace here and another in the
 * handler.
 */
function workspaceIdIn(path: string, pattern: RegExp): string | undefined {
  const segment = pattern.exec(path)?.[1]

  return segment === undefined ? undefined : tryDecodeURIComponent(segment)
}

export interface WorkspaceAccessMiddlewareDependencies extends CredentialDependencies {
  readonly entitlements: EntitlementRegistry
}

/**
 * The check itself, for one workspace.
 *
 * `/mcp` calls it for an OAuth connection that covers several workspaces: the
 * middleware below finds no workspace on such a caller and lets it through, and
 * the transport checks the workspace each tool call names.
 *
 * @throws AppError 403 `entitlement_required` when the workspace is blocked.
 */
export async function requireWorkspaceAccess(entitlements: EntitlementRegistry, workspaceId: string): Promise<void> {
  const entitlement = await entitlements.check(workspaceId, WORKSPACE_ACCESS.name)

  if (entitlement.kind === 'flag' && !entitlement.granted) {
    throw new AppError('entitlement_required', 'This workspace does not have access')
  }
}

export function createWorkspaceAccessMiddleware(
  dependencies: WorkspaceAccessMiddlewareDependencies,
): MiddlewareHandler {
  /**
   * True when the handler will let this actor act on `workspaceId`: the same
   * rule as the workspace service's membership check. A bearer credential
   * reaches the one workspace it is bound to, and a session reaches each
   * workspace its user is a member of.
   */
  async function reaches(actor: Actor, workspaceId: string): Promise<boolean> {
    if (actor.kind !== 'session') {
      return actor.workspaceId === workspaceId
    }

    return (await authRepository.findMembership(dependencies.db, workspaceId, actor.userId)) !== undefined
  }

  /**
   * The workspace the request acts on: the one its path names, else the
   * actor's own.
   *
   * The path counts only when the actor can reach that workspace. For anybody
   * else the handler answers 404, and a 403 from here would tell a stranger
   * that the workspace exists and is suspended. That caller is checked on the
   * actor's own workspace, as on every other path.
   */
  async function gatedWorkspaceId(actor: Actor, path: string): Promise<string | null> {
    const named = workspaceIdIn(path, WORKSPACE_PATH)

    if (named !== undefined && (await reaches(actor, named))) {
      return named
    }

    return actorWorkspaceId(actor)
  }

  return async (context: Context, next) => {
    if (isExempt(context.req.method, context.req.path) || isPublic(context.req.path)) {
      await next()
      return
    }

    const actor = await resolveActorFrom(dependencies, context).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'unauthorized') {
        // No credential to check a workspace against. The handler this
        // reaches answers its own 401; there is nothing this gate can add.
        return undefined
      }

      throw error
    })

    const workspaceId = actor === undefined ? null : await gatedWorkspaceId(actor, context.req.path)

    // Between signup and a first workspace there is nothing to gate
    // (`POST /v1/workspaces`, `POST /v1/invites/accept`): the same case
    // `createIdempotencyMiddleware` lets through unscoped. An OAuth connection
    // that covers several workspaces has none either, until a tool call names
    // one; `/mcp` runs `requireWorkspaceAccess` for it then.
    if (workspaceId === null) {
      await next()
      return
    }

    await requireWorkspaceAccess(dependencies.entitlements, workspaceId)
    await next()
  }
}

/**
 * The same gate for `/v1/public/workspaces/:workspaceId/...`.
 *
 * A public request has no actor. Its path names the workspace it acts on, so
 * that is the workspace checked, whatever session cookie the visitor's browser
 * sends with it. A public path that names no workspace has nothing to check.
 *
 * Mount it after the public CORS layer: a cross-origin embed must be able to
 * read the refusal, and CORS answers the preflight `OPTIONS` request before
 * this runs.
 */
export function createPublicWorkspaceAccessMiddleware(entitlements: EntitlementRegistry): MiddlewareHandler {
  return async (context: Context, next) => {
    const workspaceId = workspaceIdIn(context.req.path, PUBLIC_WORKSPACE_PATH)

    if (workspaceId !== undefined) {
      await requireWorkspaceAccess(entitlements, workspaceId)
    }

    await next()
  }
}

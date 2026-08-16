import type { Context, MiddlewareHandler } from 'hono'

import { AppError } from '../../lib/errors.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { actorWorkspaceId } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { WORKSPACE_ACCESS } from './capabilities.ts'

/**
 * `POST /v1/*` and every `/mcp` call carry a fixed workspace for the whole
 * request (`api.md`): a session or key resolves to one `Actor.workspaceId`,
 * and every query it makes is scoped to that workspace server-side. This
 * blocks the request outright when that workspace's `workspace.access`
 * entitlement is not granted — inert in a self-hosted assembly, since
 * nothing registers a `GrantProvider` that answers it there
 * (`capabilities.ts`).
 *
 * Mounted the same way as `createIdempotencyMiddleware`: tolerates the
 * no-credential case, since an unauthenticated `/v1/auth/*` call has
 * nothing to check, and ahead of idempotency in `app.ts` so a blocked
 * request never reserves a key it will not be allowed to spend.
 *
 * Exempts `/v1/auth/*` and `/v1/account*`: they manage the *account*, not
 * the workspace, and a member of a workspace this gate has locked out
 * still needs to sign in, sign out, and see their own account to have any
 * chance of understanding why. There is no `/v1` endpoint to switch a
 * session to a different workspace membership — a session is bound to one
 * at login — so there is nothing further to exempt for that case.
 */
function isExempt(path: string): boolean {
  return path.startsWith('/v1/auth/') || path.startsWith('/v1/account')
}

export interface WorkspaceAccessMiddlewareDependencies extends CredentialDependencies {
  readonly entitlements: EntitlementRegistry
}

export function createWorkspaceAccessMiddleware(
  dependencies: WorkspaceAccessMiddlewareDependencies,
): MiddlewareHandler {
  return async (context: Context, next) => {
    if (isExempt(context.req.path)) {
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

    const workspaceId = actor === undefined ? null : actorWorkspaceId(actor)

    // Between signup and a first workspace there is nothing to gate
    // (`POST /v1/workspaces`, `POST /v1/invites/accept`): the same case
    // `createIdempotencyMiddleware` lets through unscoped.
    if (workspaceId === null) {
      await next()
      return
    }

    const entitlement = await dependencies.entitlements.check(workspaceId, WORKSPACE_ACCESS.name)

    if (entitlement.kind === 'flag' && !entitlement.granted) {
      throw new AppError('entitlement_required', 'This workspace does not have access')
    }

    await next()
  }
}

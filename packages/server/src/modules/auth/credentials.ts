import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'

import type { ApiKeyScope } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { hashToken } from '../../lib/tokens.ts'
import * as apiKeyRepository from '../api-keys/repository.ts'
import { readBearerToken } from '../api-keys/keys.ts'
import { isMcpPath, MCP_ROUTE_PREFIX } from '../mcp/paths.ts'
import * as oauthRepository from '../oauth/repository.ts'
import { isAccessToken } from '../oauth/tokens.ts'
import { parseMemberRole } from '../workspace/roles.ts'
import type { MemberRole } from '../workspace/roles.ts'
import { bindOAuthWorkspace } from './actor.ts'
import type { Actor, OAuthConnectionActor, OAuthWorkspaceAccess } from './actor.ts'
import * as repository from './repository.ts'
import { SESSION_COOKIE } from './session.ts'

/**
 * Turns credentials into an `Actor`. A session cookie and an API key are
 * accepted everywhere, and they must behave identically once resolved: same
 * endpoints, same shapes, same errors. An OAuth access token is accepted at
 * `/mcp` only; everywhere else it answers `401`.
 *
 * A bearer credential wins over a cookie. A client sending both is being
 * explicit about which identity it wants.
 */

/**
 * A workspace key acts with admin authority. It is created by an admin and
 * belongs to the workspace rather than a person, so there is no member row to
 * read a role from. Owner-only actions stay out of reach.
 */
const WORKSPACE_KEY_ROLE: MemberRole = 'admin'

/** Writing `last_used_at` on every request would double the write load for no gain. */
const LAST_USED_RESOLUTION_MS = 60_000

export interface CredentialDependencies {
  readonly db: Database
  readonly now: () => Date
}

function roleFromMembership(role: string): MemberRole {
  const parsed = parseMemberRole(role)

  if (parsed === undefined) {
    throw new Error(`workspace_members.role holds "${role}", which its check constraint forbids`)
  }

  return parsed
}

async function resolveSessionActor(
  dependencies: CredentialDependencies,
  token: string,
): Promise<Actor> {
  const session = await repository.findLiveSessionByTokenHash(
    dependencies.db,
    hashToken(token),
    dependencies.now(),
  )

  if (session === undefined) {
    throw AppError.unauthorized('Your session has expired')
  }

  const membership =
    session.activeWorkspaceId === null
      ? undefined
      : await repository.findMembership(dependencies.db, session.activeWorkspaceId, session.userId)

  // A workspace the user has been removed from resolves to no workspace rather
  // than an error: losing one must not lock the account out of the product.
  return {
    kind: 'session',
    userId: session.userId,
    sessionId: session.id,
    workspaceId: membership?.workspaceId ?? null,
    role: membership === undefined ? null : roleFromMembership(membership.role),
    memberId: membership?.id ?? null,
  }
}

async function resolveApiKeyActor(
  dependencies: CredentialDependencies,
  secret: string,
): Promise<Actor> {
  const record = await apiKeyRepository.findBySecretHash(dependencies.db, hashToken(secret))

  if (record === undefined) {
    throw AppError.unauthorized('That API key is not valid')
  }

  const now = dependencies.now()

  if (record.lastUsedAt === null || now.getTime() - record.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await apiKeyRepository.touchLastUsed(dependencies.db, record.id, now)
  }

  if (record.userId === null) {
    return {
      kind: 'api_key',
      apiKeyId: record.id,
      userId: null,
      workspaceId: record.workspaceId,
      role: WORKSPACE_KEY_ROLE,
      scopes: record.scopes as ApiKeyScope[],
      memberId: null,
    }
  }

  const membership = await repository.findMembership(dependencies.db, record.workspaceId, record.userId)

  // A personal key acts as its user. If they are no longer a member, it acts as
  // nobody, so the key stops working rather than keeping stale access.
  if (membership === undefined) {
    throw AppError.unauthorized('That API key is not valid')
  }

  return {
    kind: 'api_key',
    apiKeyId: record.id,
    userId: record.userId,
    workspaceId: record.workspaceId,
    role: roleFromMembership(membership.role),
    scopes: record.scopes as ApiKeyScope[],
    memberId: membership.id,
  }
}

/**
 * An OAuth caller, from its access token.
 *
 * The token must be live and issued for `/mcp` (its RFC 8707 audience). It
 * reaches the workspaces of the grants under its connection, and of those only
 * the ones its user is still a member of. That check is the same one a
 * personal key gets: access ends with the membership, whether or not the
 * `workspace.member.removed` subscriber has run.
 *
 * A connection with one grant answers an `OAuthActor` for that workspace, as it
 * always did. A connection with more answers an `OAuthConnectionActor`, which
 * has no workspace until `/mcp` binds it to the one a tool call names. The
 * number of grants decides, not the number of live memberships, so what a
 * client sees does not change when a membership ends.
 */
async function resolveOAuthActor(dependencies: CredentialDependencies, secret: string): Promise<Actor> {
  const now = dependencies.now()
  const found = await oauthRepository.findLiveAccessToken(dependencies.db, hashToken(secret), now)

  if (found === undefined || !isMcpResource(found.token.resource)) {
    throw AppError.unauthorized('That OAuth token is not valid or has expired')
  }

  const { connection, token } = found
  const workspaces: OAuthWorkspaceAccess[] = found.grants.flatMap(({ grant, workspaceName, membership }) =>
    membership === null
      ? []
      : [
          {
            grantId: grant.id,
            workspaceId: grant.workspaceId,
            workspaceName,
            role: roleFromMembership(membership.role),
            memberId: membership.id,
          },
        ],
  )
  const [only] = workspaces

  if (only === undefined) {
    throw AppError.unauthorized('That OAuth token is not valid or has expired')
  }

  const connectionActor: OAuthConnectionActor = {
    kind: 'oauth_connection',
    connectionId: connection.id,
    clientId: found.clientId,
    userId: connection.userId,
    workspaceId: null,
    role: null,
    scopes: token.scopes as ApiKeyScope[],
    memberId: null,
    workspaces,
  }

  if (found.grants.length > 1) {
    return connectionActor
  }

  const used = found.grants.find(({ grant }) => grant.id === only.grantId)

  await touchOAuthGrant(dependencies, only.grantId, used?.grant.lastUsedAt ?? null)

  const bound = bindOAuthWorkspace(connectionActor, only.workspaceId)

  if (bound === undefined) {
    throw AppError.unauthorized('That OAuth token is not valid or has expired')
  }

  return bound
}

async function touchOAuthGrant(
  dependencies: CredentialDependencies,
  grantId: string,
  lastUsedAt: Date | null,
): Promise<void> {
  const now = dependencies.now()

  if (lastUsedAt === null || now.getTime() - lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await oauthRepository.touchGrant(dependencies.db, grantId, now)
  }
}

/**
 * Records that a grant was used. `/mcp` calls it for the workspace a tool call
 * names on a connection that covers more than one; a connection with one
 * workspace is recorded when its token resolves.
 */
export async function recordOAuthGrantUse(dependencies: CredentialDependencies, grantId: string): Promise<void> {
  // Without the stored time every call would write. One read keeps the same
  // resolution a single-workspace connection has.
  const grant = await oauthRepository.findGrant(dependencies.db, grantId)

  if (grant !== undefined) {
    await touchOAuthGrant(dependencies, grant.id, grant.lastUsedAt)
  }
}

/** The authorization server issues tokens for `<origin>/mcp` and nothing else. */
function isMcpResource(resource: string): boolean {
  try {
    return new URL(resource).pathname === MCP_ROUTE_PREFIX
  } catch {
    return false
  }
}

export interface ResolveActorOptions {
  /**
   * Whether an OAuth access token may resolve. True for `/mcp` only: a token
   * is issued for that resource, and `/v1` stays sessions and API keys.
   */
  readonly acceptOAuth?: boolean
}

/**
 * @throws AppError 401 when no credential is present, the one presented is
 *   unknown or expired, or it is an OAuth token on a surface that takes none.
 */
export async function resolveActor(
  dependencies: CredentialDependencies,
  credentials: { readonly bearer?: string | undefined; readonly cookie?: string | undefined },
  options: ResolveActorOptions = {},
): Promise<Actor> {
  if (credentials.bearer !== undefined && credentials.bearer.length > 0) {
    if (isAccessToken(credentials.bearer)) {
      if (options.acceptOAuth !== true) {
        throw AppError.unauthorized('An OAuth token works only at /mcp. Use an API key for the REST API')
      }

      return resolveOAuthActor(dependencies, credentials.bearer)
    }

    return resolveApiKeyActor(dependencies, credentials.bearer)
  }

  if (credentials.cookie !== undefined && credentials.cookie.length > 0) {
    return resolveSessionActor(dependencies, credentials.cookie)
  }

  throw AppError.unauthorized('Sign in or present an API key to continue')
}

/**
 * Reads both credential carriers off a request.
 *
 * The path decides whether an OAuth token is accepted, so the middleware that
 * runs on both `/v1` and `/mcp` (the rate limiter, the workspace access gate)
 * gets the right answer on each without being told.
 */
export function resolveActorFrom(
  dependencies: CredentialDependencies,
  context: Context,
): Promise<Actor> {
  return resolveActor(
    dependencies,
    {
      bearer: readBearerToken(context.req.header('Authorization')),
      cookie: getCookie(context, SESSION_COOKIE),
    },
    { acceptOAuth: isMcpPath(context.req.path) },
  )
}

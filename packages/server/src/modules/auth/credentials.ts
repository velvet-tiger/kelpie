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
import type { Actor } from './actor.ts'
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
 * An OAuth grant, from its access token.
 *
 * The token must be live, issued for `/mcp` (its RFC 8707 audience), and its
 * user must still be a member of the grant's workspace. The last check is the
 * same one a personal key gets: access ends with the membership, whether or
 * not the `workspace.member.removed` subscriber has run.
 */
async function resolveOAuthActor(dependencies: CredentialDependencies, secret: string): Promise<Actor> {
  const now = dependencies.now()
  const found = await oauthRepository.findLiveAccessToken(dependencies.db, hashToken(secret), now)

  if (found === undefined || !isMcpResource(found.token.resource)) {
    throw AppError.unauthorized('That OAuth token is not valid or has expired')
  }

  const { grant, token } = found
  const membership = await repository.findMembership(dependencies.db, grant.workspaceId, grant.userId)

  if (membership === undefined) {
    throw AppError.unauthorized('That OAuth token is not valid or has expired')
  }

  if (grant.lastUsedAt === null || now.getTime() - grant.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await oauthRepository.touchGrant(dependencies.db, grant.id, now)
  }

  return {
    kind: 'oauth',
    grantId: grant.id,
    clientId: found.clientId,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    role: roleFromMembership(membership.role),
    scopes: token.scopes as ApiKeyScope[],
    memberId: membership.id,
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

import type { ApiKeyScope, MemberRole } from '@kelpie/schemas'
import { API_KEY_SCOPES, MEMBER_ROLES } from '@kelpie/schemas'

import { requireSessionActor } from '../../lib/actor.ts'
import type { Actor } from '../../lib/actor.ts'
import type { Database } from '../../lib/database.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { generateToken, hashToken, tokenHashesMatch } from '../../lib/tokens.ts'
import * as authRepository from '../auth/repository.ts'
import { MCP_ROUTE_PREFIX } from '../mcp/paths.ts'
import {
  METADATA_DOCUMENT_TTL_MS,
  OAuthClientError,
  describeRedirectHost,
  fetchClientMetadata,
  isMetadataDocumentClientId,
  redirectUriMatches,
  validateRegistration,
} from './clients.ts'
import type { Fetch, RegistrationBody } from './clients.ts'
import * as repository from './repository.ts'
import {
  ACCESS_TOKEN_LIFETIME_MS,
  ACCESS_TOKEN_PREFIX,
  CLIENT_SECRET_PREFIX,
  CODE_LIFETIME_MS,
  REFRESH_TOKEN_LIFETIME_MS,
  REFRESH_TOKEN_PREFIX,
  REQUEST_LIFETIME_MS,
  isValidChallenge,
  isValidVerifier,
  mintCode,
  mintSecret,
  pkceMatches,
} from './tokens.ts'

/**
 * Kelpie's authorization server for MCP.
 *
 * It issues tokens for one resource, this deployment's `/mcp`, and nothing
 * else. A grant is one user, one workspace, one client and a set of scopes,
 * and acts as that user through `modules/auth/credentials.ts`.
 */

/**
 * What a client gets when it names no scope: enough to read and write CRM
 * records, nothing administrative. A tool that needs more answers
 * `insufficient_scope` and the client asks the user again.
 */
export const DEFAULT_SCOPES: readonly ApiKeyScope[] = ['read:objects', 'write:objects']

/** Registered clients that never connected are removed after this long. */
const UNUSED_CLIENT_LIFETIME_MS = 30 * 24 * 60 * 60_000

/**
 * An error the OAuth standards define, rendered as `{ error, error_description }`
 * rather than Kelpie's own error body, because the client reading it is an
 * OAuth library, not a Kelpie one.
 */
export class OAuthError extends Error {
  readonly status: 400 | 401
  readonly error: string
  readonly description: string

  constructor(status: 400 | 401, error: string, description: string) {
    super(description)
    this.name = 'OAuthError'
    this.status = status
    this.error = error
    this.description = description
  }
}

export interface OAuthServiceDependencies {
  readonly db: Database
  readonly createId: IdFactory
  readonly now: () => Date
  /** The deployment's `APP_BASE_URL`. The issuer is its origin. */
  readonly appBaseUrl: string
  readonly egress: EgressGuard
  readonly fetch: Fetch
  /** Injected only so tests can pin secrets. */
  readonly newToken?: () => string
}

export interface OAuthEndpoints {
  readonly issuer: string
  /** The one resource tokens are issued for: `<issuer>/mcp`. */
  readonly resource: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint: string
  readonly revocationEndpoint: string
  readonly resourceMetadataUrl: string
}

/** Every endpoint URL, built once from `APP_BASE_URL`. A client compares these as exact strings. */
export function oauthEndpoints(appBaseUrl: string): OAuthEndpoints {
  const issuer = new URL(appBaseUrl).origin

  return {
    issuer,
    resource: `${issuer}${MCP_ROUTE_PREFIX}`,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    registrationEndpoint: `${issuer}/oauth/register`,
    revocationEndpoint: `${issuer}/oauth/revoke`,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource${MCP_ROUTE_PREFIX}`,
  }
}

/**
 * RFC 8707 compares resource indicators as URIs. Lower-case scheme and host,
 * no default port and no trailing slash, so `HTTPS://Kelpie.test/mcp/` and
 * `https://kelpie.test/mcp` are the same resource.
 */
function canonicalResource(value: string): string | undefined {
  try {
    const url = new URL(value)

    if (url.hash.length > 0) {
      return undefined
    }

    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, '') : ''

    return `${url.origin}${path}${url.search}`
  } catch {
    return undefined
  }
}

const KNOWN_SCOPES = new Set<string>(API_KEY_SCOPES)

/** A space-separated `scope` parameter. Unknown values are an error, not silently dropped. */
function parseScopeParameter(raw: string | undefined): ApiKeyScope[] | { readonly unknown: string } {
  if (raw === undefined || raw.trim().length === 0) {
    return [...DEFAULT_SCOPES]
  }

  const requested = [...new Set(raw.trim().split(/\s+/u))]
  const unknown = requested.find((scope) => !KNOWN_SCOPES.has(scope))

  if (unknown !== undefined) {
    return { unknown }
  }

  return requested as ApiKeyScope[]
}

function parseRole(value: string): MemberRole {
  const role = MEMBER_ROLES.find((candidate) => candidate === value)

  if (role === undefined) {
    throw new Error(`workspace_members.role holds "${value}", which its check constraint forbids`)
  }

  return role
}

export type AuthorizeOutcome =
  /** Send the browser to the consent page for this request. */
  | { readonly kind: 'consent'; readonly requestId: string }
  /** Send the browser back to the client with an error. */
  | { readonly kind: 'redirect'; readonly url: string }
  /**
   * The client or its redirect URI could not be trusted, so there is nowhere
   * safe to send the browser. Shown to the person instead (RFC 6749 §4.1.2.1).
   */
  | { readonly kind: 'invalid'; readonly message: string }

export interface ConsentView {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly scopes: readonly ApiKeyScope[]
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly role: MemberRole }[]
  readonly expiresAt: Date
}

export interface GrantView {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly scopes: readonly ApiKeyScope[]
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

export interface TokenResponse {
  readonly access_token: string
  readonly token_type: 'Bearer'
  readonly expires_in: number
  readonly refresh_token: string
  readonly scope: string
}

export interface RegisteredClient {
  readonly client_id: string
  readonly client_id_issued_at: number
  readonly client_secret?: string
  readonly client_secret_expires_at?: number
  readonly client_name: string
  readonly redirect_uris: readonly string[]
  readonly token_endpoint_auth_method: string
  readonly grant_types: readonly string[]
  readonly response_types: readonly string[]
  readonly client_uri?: string
  readonly logo_uri?: string
}

/** How a client authenticated at the token or revocation endpoint. */
export interface ClientCredentials {
  readonly clientId: string | undefined
  readonly clientSecret: string | undefined
  /** True when they came in an `Authorization: Basic` header rather than the form. */
  readonly viaBasic: boolean
}

export interface OAuthService {
  readonly endpoints: OAuthEndpoints
  authorize(parameters: Readonly<Record<string, string | undefined>>): Promise<AuthorizeOutcome>
  getRequest(actor: Actor, id: string): Promise<ConsentView>
  approve(actor: Actor, id: string, workspaceId: string, scopes: readonly ApiKeyScope[]): Promise<string>
  deny(actor: Actor, id: string): Promise<string>
  token(form: Readonly<Record<string, string | undefined>>, credentials: ClientCredentials): Promise<TokenResponse>
  revoke(form: Readonly<Record<string, string | undefined>>, credentials: ClientCredentials): Promise<void>
  register(body: RegistrationBody): Promise<RegisteredClient>
  listGrants(actor: Actor): Promise<readonly GrantView[]>
  revokeGrant(actor: Actor, id: string): Promise<void>
  removeMemberGrants(workspaceId: string, userId: string): Promise<void>
}

export function createOAuthService(dependencies: OAuthServiceDependencies): OAuthService {
  const endpoints = oauthEndpoints(dependencies.appBaseUrl)
  const newToken = dependencies.newToken ?? generateToken

  function redirectTo(redirectUri: string, parameters: Readonly<Record<string, string | null | undefined>>): string {
    const url = new URL(redirectUri)

    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(name, value)
      }
    }

    // RFC 9207: every response names the issuer, errors included, so a client
    // talking to several servers can tell which one answered.
    url.searchParams.set('iss', endpoints.issuer)

    return url.toString()
  }

  /**
   * The client row for a `client_id`, fetching a metadata document when it is
   * new or its cache is stale.
   *
   * @throws OAuthClientError when the client is unknown or its document fails.
   */
  async function resolveClient(clientId: string): Promise<repository.OAuthClientRecord> {
    const cached = await repository.findClientByClientId(dependencies.db, clientId)

    if (!isMetadataDocumentClientId(clientId)) {
      if (cached === undefined || cached.kind !== 'registered') {
        throw new OAuthClientError('invalid_client', 'This client is not registered')
      }

      return cached
    }

    const now = dependencies.now()
    const fresh =
      cached?.metadataFetchedAt !== null &&
      cached?.metadataFetchedAt !== undefined &&
      now.getTime() - cached.metadataFetchedAt.getTime() < METADATA_DOCUMENT_TTL_MS

    if (cached !== undefined && fresh) {
      return cached
    }

    const document = await fetchClientMetadata(clientId, { egress: dependencies.egress, fetch: dependencies.fetch })

    return repository.upsertMetadataClient(dependencies.db, {
      id: cached?.id ?? dependencies.createId('oauthClient'),
      clientId,
      kind: 'metadata_document',
      clientName: document.clientName,
      clientUri: document.clientUri,
      logoUri: document.logoUri,
      redirectUris: [...document.redirectUris],
      tokenEndpointAuthMethod: 'none',
      metadataFetchedAt: now,
      updatedAt: now,
    })
  }

  /**
   * Checks the client at the token and revocation endpoints.
   *
   * A public client proves nothing here; PKCE is its proof. A confidential one
   * must present its secret the way it registered to.
   *
   * @throws OAuthError 401 `invalid_client`.
   */
  async function authenticateClient(credentials: ClientCredentials): Promise<repository.OAuthClientRecord> {
    if (credentials.clientId === undefined || credentials.clientId.length === 0) {
      throw new OAuthError(401, 'invalid_client', 'client_id is required')
    }

    const client = await repository.findClientByClientId(dependencies.db, credentials.clientId)

    if (client === undefined) {
      throw new OAuthError(401, 'invalid_client', 'This client is not known')
    }

    if (client.tokenEndpointAuthMethod === 'none') {
      return client
    }

    const expectedBasic = client.tokenEndpointAuthMethod === 'client_secret_basic'

    if (
      credentials.clientSecret === undefined ||
      client.clientSecretHash === null ||
      credentials.viaBasic !== expectedBasic ||
      !tokenHashesMatch(hashToken(credentials.clientSecret), client.clientSecretHash)
    ) {
      throw new OAuthError(401, 'invalid_client', 'Client authentication failed')
    }

    return client
  }

  /** @throws OAuthError `invalid_target` for a resource other than this deployment's `/mcp`. */
  function requireOurResource(raw: string | undefined): string {
    if (raw === undefined || raw.length === 0) {
      return endpoints.resource
    }

    if (canonicalResource(raw) !== endpoints.resource) {
      throw new OAuthError(400, 'invalid_target', `Tokens are issued for ${endpoints.resource} only`)
    }

    return endpoints.resource
  }

  async function issueTokens(
    grantId: string,
    resource: string,
    accessScopes: readonly ApiKeyScope[],
    refreshScopes: readonly ApiKeyScope[],
  ): Promise<TokenResponse> {
    const now = dependencies.now()
    const access = mintSecret(ACCESS_TOKEN_PREFIX, newToken)
    const refresh = mintSecret(REFRESH_TOKEN_PREFIX, newToken)

    await dependencies.db.transaction(async (tx) => {
      await repository.insertToken(tx, {
        id: dependencies.createId('oauthToken'),
        grantId,
        kind: 'access',
        tokenHash: access.hash,
        resource,
        scopes: [...accessScopes],
        expiresAt: new Date(now.getTime() + ACCESS_TOKEN_LIFETIME_MS),
      })
      await repository.insertToken(tx, {
        id: dependencies.createId('oauthToken'),
        grantId,
        kind: 'refresh',
        tokenHash: refresh.hash,
        resource,
        scopes: [...refreshScopes],
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
      })
    })

    // Housekeeping on the path that creates rows, so the tables stay bounded
    // without a scheduled job.
    await repository.deleteExpiredTokens(dependencies.db, now)

    return {
      access_token: access.secret,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_LIFETIME_MS / 1000),
      refresh_token: refresh.secret,
      scope: accessScopes.join(' '),
    }
  }

  async function exchangeCode(
    client: repository.OAuthClientRecord,
    form: Readonly<Record<string, string | undefined>>,
  ): Promise<TokenResponse> {
    const code = form.code

    if (code === undefined || code.length === 0) {
      throw new OAuthError(400, 'invalid_request', 'code is required')
    }

    const record = await repository.findTokenByHash(dependencies.db, 'code', hashToken(code))
    const grant = record === undefined ? undefined : await repository.findGrant(dependencies.db, record.grantId)

    if (record === undefined || grant === undefined || grant.clientRowId !== client.id) {
      throw new OAuthError(400, 'invalid_grant', 'The code is not valid')
    }

    const now = dependencies.now()

    if (!(await repository.spendToken(dependencies.db, record.id, now))) {
      // A code presented twice was copied. OAuth 2.1 §4.1.3: revoke what it issued.
      await repository.deleteGrantById(dependencies.db, grant.id)

      throw new OAuthError(400, 'invalid_grant', 'The code has already been used')
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new OAuthError(400, 'invalid_grant', 'The code has expired')
    }

    if (form.redirect_uri !== undefined && form.redirect_uri !== record.redirectUri) {
      throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request')
    }

    const verifier = form.code_verifier

    if (
      verifier === undefined ||
      !isValidVerifier(verifier) ||
      record.codeChallenge === null ||
      !pkceMatches(verifier, record.codeChallenge)
    ) {
      throw new OAuthError(400, 'invalid_grant', 'The PKCE code_verifier does not match')
    }

    if (form.resource !== undefined && canonicalResource(form.resource) !== record.resource) {
      throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization request')
    }

    const scopes = record.scopes as ApiKeyScope[]

    return issueTokens(grant.id, record.resource, scopes, scopes)
  }

  async function refresh(
    client: repository.OAuthClientRecord,
    form: Readonly<Record<string, string | undefined>>,
  ): Promise<TokenResponse> {
    const secret = form.refresh_token

    if (secret === undefined || secret.length === 0) {
      throw new OAuthError(400, 'invalid_request', 'refresh_token is required')
    }

    const record = await repository.findTokenByHash(dependencies.db, 'refresh', hashToken(secret))
    const grant = record === undefined ? undefined : await repository.findGrant(dependencies.db, record.grantId)

    if (record === undefined || grant === undefined || grant.clientRowId !== client.id) {
      throw new OAuthError(400, 'invalid_grant', 'The refresh token is not valid')
    }

    const now = dependencies.now()

    if (!(await repository.spendToken(dependencies.db, record.id, now))) {
      // Rotation means a refresh token is good once. A second use means two
      // parties hold it; revoking the grant cuts off both.
      await repository.deleteGrantById(dependencies.db, grant.id)

      throw new OAuthError(400, 'invalid_grant', 'The refresh token has already been used')
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new OAuthError(400, 'invalid_grant', 'The refresh token has expired')
    }

    if (form.resource !== undefined && canonicalResource(form.resource) !== record.resource) {
      throw new OAuthError(400, 'invalid_target', 'resource does not match the original grant')
    }

    const held = record.scopes as ApiKeyScope[]
    let accessScopes: ApiKeyScope[] = held

    // RFC 6749 §6: a refresh may narrow the scope, never widen it.
    if (form.scope !== undefined && form.scope.trim().length > 0) {
      const requested = parseScopeParameter(form.scope)

      if (!Array.isArray(requested) || requested.some((scope) => !held.includes(scope))) {
        throw new OAuthError(400, 'invalid_scope', 'A refresh may not ask for scopes the grant does not hold')
      }

      accessScopes = requested
    }

    return issueTokens(grant.id, record.resource, accessScopes, held)
  }

  return {
    endpoints,

    async authorize(parameters) {
      const clientId = parameters.client_id

      if (clientId === undefined || clientId.length === 0) {
        return { kind: 'invalid', message: 'The request has no client_id.' }
      }

      let client: repository.OAuthClientRecord

      try {
        client = await resolveClient(clientId)
      } catch (error: unknown) {
        if (error instanceof OAuthClientError) {
          return { kind: 'invalid', message: error.message }
        }

        throw error
      }

      // Omitted is allowed only when there is exactly one to fall back on.
      const redirectUri =
        parameters.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined)

      if (redirectUri === undefined || !redirectUriMatches(client.redirectUris, redirectUri)) {
        return { kind: 'invalid', message: 'The redirect_uri is not registered for this client.' }
      }

      // From here the redirect URI is trusted, so errors go back to the client.
      const state = parameters.state
      const fail = (error: string, description: string): AuthorizeOutcome => ({
        kind: 'redirect',
        url: redirectTo(redirectUri, { error, error_description: description, state }),
      })

      if (parameters.response_type !== 'code') {
        return fail('unsupported_response_type', 'Only response_type=code is supported')
      }

      const challenge = parameters.code_challenge

      if (challenge === undefined || !isValidChallenge(challenge) || parameters.code_challenge_method !== 'S256') {
        return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required')
      }

      if (
        parameters.resource !== undefined &&
        canonicalResource(parameters.resource) !== endpoints.resource
      ) {
        return fail('invalid_target', `Tokens are issued for ${endpoints.resource} only`)
      }

      const scopes = parseScopeParameter(parameters.scope)

      if (!Array.isArray(scopes)) {
        return fail('invalid_scope', `The scope "${scopes.unknown}" is not known`)
      }

      const now = dependencies.now()

      await repository.deleteExpiredRequests(dependencies.db, now)

      const request = await repository.insertRequest(dependencies.db, {
        id: dependencies.createId('oauthRequest'),
        clientRowId: client.id,
        redirectUri,
        codeChallenge: challenge,
        scopes,
        resource: endpoints.resource,
        state: state ?? null,
        expiresAt: new Date(now.getTime() + REQUEST_LIFETIME_MS),
      })

      return { kind: 'consent', requestId: request.id }
    },

    async getRequest(actor, id) {
      const session = requireSessionActor(actor)
      const request = await repository.findLiveRequest(dependencies.db, id, dependencies.now())
      const client =
        request === undefined ? undefined : await repository.findClientById(dependencies.db, request.clientRowId)

      if (request === undefined || client === undefined) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const memberships = await repository.listMembershipsForUser(dependencies.db, session.userId)

      return {
        id: request.id,
        clientName: client.clientName,
        clientHost:
          client.kind === 'metadata_document'
            ? new URL(client.clientId).hostname
            : describeRedirectHost(request.redirectUri),
        clientUri: client.clientUri,
        logoUri: client.logoUri,
        scopes: request.scopes as ApiKeyScope[],
        workspaces: memberships.map((membership) => ({
          id: membership.id,
          name: membership.name,
          role: parseRole(membership.role),
        })),
        expiresAt: request.expiresAt,
      }
    },

    async approve(actor, id, workspaceId, scopes) {
      const session = requireSessionActor(actor)
      const now = dependencies.now()
      const request = await repository.findLiveRequest(dependencies.db, id, now)

      if (request === undefined) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const membership = await authRepository.findMembership(dependencies.db, workspaceId, session.userId)

      if (membership === undefined) {
        throw AppError.validationFailed('Choose a workspace you belong to', [
          { field: 'workspace_id', message: 'You are not a member of this workspace' },
        ])
      }

      const chosen = [...new Set(scopes)]

      if (chosen.length === 0) {
        throw AppError.validationFailed('Allow at least one kind of access', [
          { field: 'scopes', message: 'Choose at least one scope' },
        ])
      }

      const extra = chosen.filter((scope) => !request.scopes.includes(scope))

      if (extra.length > 0) {
        throw AppError.validationFailed('You can remove requested access, not add to it', [
          { field: 'scopes', message: `Not requested: ${extra.join(', ')}` },
        ])
      }

      if (!(await repository.takeRequest(dependencies.db, request.id))) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const code = mintCode(newToken)

      await dependencies.db.transaction(async (tx) => {
        const grant = await repository.upsertGrant(tx, {
          id: dependencies.createId('oauthGrant'),
          workspaceId,
          userId: session.userId,
          clientRowId: request.clientRowId,
          scopes: chosen,
          updatedAt: now,
        })

        await repository.deleteIssuedTokensForGrant(tx, grant.id)
        await repository.insertToken(tx, {
          id: dependencies.createId('oauthToken'),
          grantId: grant.id,
          kind: 'code',
          tokenHash: code.hash,
          resource: request.resource,
          scopes: chosen,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
        })
      })

      return redirectTo(request.redirectUri, { code: code.secret, state: request.state })
    },

    async deny(actor, id) {
      requireSessionActor(actor)

      const request = await repository.findLiveRequest(dependencies.db, id, dependencies.now())

      if (request === undefined || !(await repository.takeRequest(dependencies.db, request.id))) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      return redirectTo(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied the request',
        state: request.state,
      })
    },

    async token(form, credentials) {
      const client = await authenticateClient(credentials)

      requireOurResource(form.resource)

      if (form.grant_type === 'authorization_code') {
        return exchangeCode(client, form)
      }

      if (form.grant_type === 'refresh_token') {
        return refresh(client, form)
      }

      throw new OAuthError(400, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token')
    },

    async revoke(form, credentials) {
      const client = await authenticateClient(credentials)
      const secret = form.token

      if (secret === undefined || secret.length === 0) {
        throw new OAuthError(400, 'invalid_request', 'token is required')
      }

      const hash = hashToken(secret)
      const record =
        (await repository.findTokenByHash(dependencies.db, 'refresh', hash)) ??
        (await repository.findTokenByHash(dependencies.db, 'access', hash))
      const grant = record === undefined ? undefined : await repository.findGrant(dependencies.db, record.grantId)

      // RFC 7009 §2.2: an unknown token, or one for another client, still
      // answers 200. Saying otherwise would tell a caller which tokens exist.
      if (record === undefined || grant === undefined || grant.clientRowId !== client.id) {
        return
      }

      // Revoking a refresh token ends the connection; an access token is just
      // that one token.
      if (record.kind === 'refresh') {
        await repository.deleteGrantById(dependencies.db, grant.id)
      } else {
        await repository.deleteToken(dependencies.db, record.id)
      }
    },

    async register(body) {
      const validated = validateRegistration(body)
      const now = dependencies.now()
      const confidential = validated.tokenEndpointAuthMethod !== 'none'
      const secret = confidential ? mintSecret(CLIENT_SECRET_PREFIX, newToken) : undefined
      const id = dependencies.createId('oauthClient')

      await repository.deleteUnusedRegisteredClients(
        dependencies.db,
        new Date(now.getTime() - UNUSED_CLIENT_LIFETIME_MS),
      )

      const client = await repository.insertClient(dependencies.db, {
        id,
        clientId: id,
        kind: 'registered',
        clientName: validated.clientName,
        clientUri: validated.clientUri,
        logoUri: validated.logoUri,
        redirectUris: [...validated.redirectUris],
        tokenEndpointAuthMethod: validated.tokenEndpointAuthMethod,
        clientSecretHash: secret?.hash ?? null,
      })

      return {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        ...(secret === undefined ? {} : { client_secret: secret.secret, client_secret_expires_at: 0 }),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(client.clientUri === null ? {} : { client_uri: client.clientUri }),
        ...(client.logoUri === null ? {} : { logo_uri: client.logoUri }),
      }
    },

    async listGrants(actor) {
      const session = requireSessionActor(actor)
      const listings = await repository.listGrantsForUser(dependencies.db, session.userId)

      return listings.map(({ grant, client, workspaceName }) => ({
        id: grant.id,
        clientName: client.clientName,
        clientHost:
          client.kind === 'metadata_document'
            ? new URL(client.clientId).hostname
            : describeRedirectHost(client.redirectUris[0] ?? ''),
        workspaceId: grant.workspaceId,
        workspaceName,
        scopes: grant.scopes as ApiKeyScope[],
        lastUsedAt: grant.lastUsedAt,
        createdAt: grant.createdAt,
      }))
    },

    async revokeGrant(actor, id) {
      const session = requireSessionActor(actor)

      // Another user's grant answers 404, the same as one that never existed.
      if ((await repository.deleteGrant(dependencies.db, session.userId, id)) === 0) {
        throw AppError.notFound('Connected app not found')
      }
    },

    async removeMemberGrants(workspaceId, userId) {
      await repository.deleteGrantsForMember(dependencies.db, workspaceId, userId)
    },
  }
}

import type { ApiKeyScope, MemberRole } from '@kelpie/schemas'
import {
  API_KEY_OPT_IN_SCOPES,
  API_KEY_SCOPES,
  MEMBER_ROLES,
  expandApiKeyScopes,
  isSensitiveApiKeyScope,
  satisfiesApiKeyScope,
  sensitiveApiKeyScopesHeld,
} from '@kelpie/schemas'

import { requireSessionActor } from '../../lib/actor.ts'
import type { Actor } from '../../lib/actor.ts'
import type { Database } from '../../lib/database.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import { generateToken, hashToken, tokenHashesMatch } from '../../lib/tokens.ts'
import * as authRepository from '../auth/repository.ts'
import { MCP_ROUTE_PREFIX } from '../mcp/paths.ts'
import {
  METADATA_DOCUMENT_TTL_MS,
  OAuthClientError,
  describeRedirectHost,
  fetchClientMetadata,
  isLocalRedirectUri,
  isMetadataDocumentClientId,
  redirectUriMatches,
  redirectUriProblem,
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
 * else. A connection is one approval: one user, one client, and a grant for
 * each workspace the user ticked. A grant is one user, one workspace, one
 * client and a set of scopes, and acts as that user through
 * `modules/auth/credentials.ts`.
 */

/**
 * What a client gets when it names no scope: enough to read and write CRM
 * records. Nothing administrative, no delete, and no write to the handbook.
 * A tool that needs more answers `insufficient_scope` and the client asks the
 * user again.
 */
export const DEFAULT_SCOPES: readonly ApiKeyScope[] = ['read:objects', 'write:objects']

/**
 * What the person on the consent page may add though the client did not ask
 * for it. Each one is a power that a client does not get by default, so the
 * person gives it on purpose or not at all. The page reads this list from the
 * request; an approval accepts these and the requested scopes, nothing else.
 * The same list as the key form offers, so the two cannot differ.
 */
export const CONSENT_EXTRA_SCOPES: readonly ApiKeyScope[] = API_KEY_OPT_IN_SCOPES

/**
 * True when a scope set gives everything `scope` gives. A preset is covered
 * when each scope it expands to is. An empty set covers nothing: an OAuth
 * grant with no scopes has no access.
 *
 * Exported for its unit test only.
 */
export function scopesCover(held: readonly ApiKeyScope[], scope: ApiKeyScope): boolean {
  const needed = [...expandApiKeyScopes([scope])]

  // A scope that expands to nothing is one this version does not know, read
  // from a row. Nothing covers it: `every` over an empty list would say yes.
  if (held.length === 0 || needed.length === 0) {
    return false
  }

  return needed.every((granular) => satisfiesApiKeyScope(held, granular))
}

/**
 * The scopes the consent page shows apart, clear at the start and each with
 * what it risks.
 *
 * First every requested scope that gives a sensitive power, under whatever
 * name: `people:delete`, `delete:objects` and `write:all` are all here. A
 * preset that holds a sensitive scope is here whole. Showing part of it
 * ticked would need a row for each scope it expands to, and a row that says
 * "Write all" must not give less than that. Then the scopes that are always
 * offered. The rule is by power and not by name, so no spelling of a request
 * gets a delete or a handbook write ticked.
 */
function offeredExtraScopes(requested: readonly ApiKeyScope[]): ApiKeyScope[] {
  const sensitive = requested.filter(isSensitiveApiKeyScope)

  return [...sensitive, ...CONSENT_EXTRA_SCOPES.filter((extra) => !sensitive.includes(extra))]
}

/** Registered clients that never connected are removed after this long. */
const UNUSED_CLIENT_LIFETIME_MS = 30 * 24 * 60 * 60_000

/**
 * A cached metadata-document client that nothing refers to is removed this
 * long after the last authorize request that named it. Short, because any URL
 * a stranger sends makes a row. Longer than a pending request lives, so a
 * client whose user is still on the sign-in page is not fetched twice.
 */
export const UNUSED_METADATA_CLIENT_LIFETIME_MS = 60 * 60_000

/** A `client_id` is a URL a stranger chose, of any length. The log keeps the start of it. */
const MAX_LOGGED_CLIENT_ID_LENGTH = 300

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
  /** The egress guard's own `fetch` in production: the metadata document URL is a stranger's. */
  readonly fetch: Fetch
  readonly log: Logger
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
  /**
   * The request cannot go on, and the person is shown why on a page of this
   * deployment. Never a redirect: anybody can register a client with a
   * redirect URI of their own and then make a link to `/oauth/authorize` that
   * fails on purpose, and a server that answered with a redirect would send
   * the person from a trusted address to that URI without a click (RFC 9700
   * §4.11). `error` is the OAuth error code when the standards give one, for
   * the developer of the client to read; a request with an untrusted client
   * or redirect URI has none.
   */
  | { readonly kind: 'invalid'; readonly message: string; readonly error?: string }

export interface ConsentView {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly scopes: readonly ApiKeyScope[]
  /** The scopes shown apart and clear: the sensitive ones requested, then `CONSENT_EXTRA_SCOPES`. */
  readonly extraScopes: readonly ApiKeyScope[]
  /**
   * True when the request does not redirect to an HTTPS address. `connected`
   * is then false and `heldScopes` empty for every workspace, whatever the
   * grants say, so the page ticks nothing from an earlier approval. The
   * `display…` fields still say what the client has, for the person to read.
   */
  readonly localClient: boolean
  readonly workspaces: readonly {
    readonly id: string
    readonly name: string
    readonly role: MemberRole
    /**
     * True when this person has a grant to this client in this workspace. An
     * authorize request comes from a browser and carries no token, so it
     * cannot name the connection that asked. Every workspace the client has
     * is marked, and the page opens with those ticked.
     */
    readonly connected: boolean
    /**
     * The `extraScopes` that this person's grant to this client in this
     * workspace gives already. The page starts those ticked, so an approval
     * for one more scope does not take away what the connection has.
     */
    readonly heldScopes: readonly ApiKeyScope[]
    /**
     * The same two facts for every request, a local one too, to be shown and
     * never to tick a box. The consent page goes to the browser of the
     * signed-in person and not to the program that opened the request, so a
     * program that only names the client learns nothing from them. Under
     * their own names, so that code which ticks from `connected` and
     * `heldScopes` cannot read these by mistake.
     */
    readonly displayConnected: boolean
    readonly displayHeldScopes: readonly ApiKeyScope[]
  }[]
  readonly expiresAt: Date
}

export interface GrantView {
  readonly id: string
  /** The approval this grant came from. Grants that share it share their tokens. */
  readonly connectionId: string
  readonly clientName: string
  readonly clientHost: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly scopes: readonly ApiKeyScope[]
  /** The sensitive powers `scopes` gives, under whatever names it gives them. */
  readonly extraScopes: readonly ApiKeyScope[]
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
  approve(
    actor: Actor,
    id: string,
    workspaceIds: readonly string[],
    scopes: readonly ApiKeyScope[],
  ): Promise<string>
  deny(actor: Actor, id: string): Promise<string>
  token(form: Readonly<Record<string, string | undefined>>, credentials: ClientCredentials): Promise<TokenResponse>
  revoke(form: Readonly<Record<string, string | undefined>>, credentials: ClientCredentials): Promise<void>
  register(body: RegistrationBody): Promise<RegisteredClient>
  listGrants(actor: Actor): Promise<readonly GrantView[]>
  revokeGrant(actor: Actor, id: string): Promise<void>
  revokeConnection(actor: Actor, id: string): Promise<void>
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
      const kept = await repository.touchMetadataClient(dependencies.db, cached.id, now)

      if (kept !== undefined) {
        return kept
      }
    }

    let document: Awaited<ReturnType<typeof fetchClientMetadata>>

    try {
      document = await fetchClientMetadata(clientId, { egress: dependencies.egress, fetch: dependencies.fetch })
    } catch (error: unknown) {
      if (error instanceof OAuthClientError) {
        // The caller is told one sentence for every failure. This line is
        // where an operator, or a developer who asks one, finds the cause.
        dependencies.log.warn('oauth client metadata document refused', {
          clientId: clientId.slice(0, MAX_LOGGED_CLIENT_ID_LENGTH),
          reason: error.logReason ?? error.message,
        })
      }

      throw error
    }

    // Housekeeping on the path that creates the rows, so the table stays
    // bounded without a scheduled job. Requests first: an expired request
    // must not keep its client from the prune after it.
    await repository.deleteExpiredRequests(dependencies.db, now)
    await repository.deleteUnusedMetadataClients(
      dependencies.db,
      new Date(now.getTime() - UNUSED_METADATA_CLIENT_LIFETIME_MS),
    )

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
   * The pending request a person may still answer. A request stored by an
   * earlier version can hold a redirect URI that `redirectUriProblem` refuses
   * now; it is treated as gone, so no approval or denial sends a browser there.
   */
  async function findAnswerableRequest(id: string, now: Date): Promise<repository.OAuthRequestRecord | undefined> {
    const request = await repository.findLiveRequest(dependencies.db, id, now)

    return request !== undefined && redirectUriProblem(request.redirectUri) === undefined ? request : undefined
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

  /**
   * Inserts an access token and a refresh token under a connection. Takes the
   * transaction, so the caller decides what else commits with them.
   */
  async function insertTokenPair(
    tx: repository.Queryable,
    now: Date,
    connectionId: string,
    resource: string,
    accessScopes: readonly ApiKeyScope[],
    refreshScopes: readonly ApiKeyScope[],
  ): Promise<TokenResponse> {
    const access = mintSecret(ACCESS_TOKEN_PREFIX, newToken)
    const refresh = mintSecret(REFRESH_TOKEN_PREFIX, newToken)

    await repository.insertToken(tx, {
      id: dependencies.createId('oauthToken'),
      connectionId,
      kind: 'access',
      tokenHash: access.hash,
      resource,
      scopes: [...accessScopes],
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_LIFETIME_MS),
    })
    await repository.insertToken(tx, {
      id: dependencies.createId('oauthToken'),
      connectionId,
      kind: 'refresh',
      tokenHash: refresh.hash,
      resource,
      scopes: [...refreshScopes],
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
    })

    return {
      access_token: access.secret,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_LIFETIME_MS / 1000),
      refresh_token: refresh.secret,
      scope: accessScopes.join(' '),
    }
  }

  /** Housekeeping on the path that creates token rows, so the tables stay bounded without a scheduled job. */
  async function sweepTokens(now: Date): Promise<void> {
    await repository.deleteExpiredTokens(dependencies.db, now)
    // A workspace that was deleted took its grants with it through the cascade,
    // and nothing here saw that happen.
    await repository.deleteConnectionsWithoutGrants(dependencies.db)
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
    const connection =
      record === undefined ? undefined : await repository.findConnection(dependencies.db, record.connectionId)

    if (record === undefined || connection === undefined || connection.clientRowId !== client.id) {
      throw new OAuthError(400, 'invalid_grant', 'The code is not valid')
    }

    // A code presented twice was copied. OAuth 2.1 §4.1.3: revoke what it issued.
    const refuseReplay = async (): Promise<never> => {
      await repository.deleteConnectionById(dependencies.db, connection.id)

      throw new OAuthError(400, 'invalid_grant', 'The code has already been used')
    }

    if (record.usedAt !== null) {
      return refuseReplay()
    }

    const now = dependencies.now()

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new OAuthError(400, 'invalid_grant', 'The code has expired')
    }

    // Every check comes before the code is spent. A request that fails one
    // leaves the code good, so a party that saw the code but lacks the
    // verifier cannot use it up before the client it was issued to does. That
    // party gets no useful number of tries: a verifier has 256 bits or more,
    // the code lasts a minute, and the endpoint has a rate limit.
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

    // The code is spent in the transaction that inserts the tokens, so a code
    // is never spent with nothing issued. Two requests can both pass the
    // checks above; the conditional update in `spendToken` lets one of them
    // through, and the other is a replay.
    const tokens = await dependencies.db.transaction(async (tx) =>
      (await repository.spendToken(tx, record.id, now))
        ? insertTokenPair(tx, now, connection.id, record.resource, scopes, scopes)
        : undefined,
    )

    if (tokens === undefined) {
      return refuseReplay()
    }

    await sweepTokens(now)

    return tokens
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
    const connection =
      record === undefined ? undefined : await repository.findConnection(dependencies.db, record.connectionId)

    if (record === undefined || connection === undefined || connection.clientRowId !== client.id) {
      throw new OAuthError(400, 'invalid_grant', 'The refresh token is not valid')
    }

    // Rotation means a refresh token is good once. A second use means two
    // parties hold it; deleting the connection cuts off both, in every
    // workspace it covers.
    const refuseReplay = async (): Promise<never> => {
      await repository.deleteConnectionById(dependencies.db, connection.id)

      throw new OAuthError(400, 'invalid_grant', 'The refresh token has already been used')
    }

    if (record.usedAt !== null) {
      return refuseReplay()
    }

    const now = dependencies.now()

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new OAuthError(400, 'invalid_grant', 'The refresh token has expired')
    }

    // Every check comes before the token is spent, as for a code. A client
    // that sends a wrong `resource` or `scope` keeps its refresh token and can
    // ask again. Spent first, the token would be gone with nothing issued, and
    // the client's next try would be a replay that ends the connection.
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

    // Spent in the transaction that inserts the new pair, so a refresh token
    // is never spent with nothing issued. Two requests can both pass the
    // checks above; the conditional update in `spendToken` lets one of them
    // through, and the other is a replay.
    const tokens = await dependencies.db.transaction(async (tx) =>
      (await repository.spendToken(tx, record.id, now))
        ? insertTokenPair(tx, now, connection.id, record.resource, accessScopes, held)
        : undefined,
    )

    if (tokens === undefined) {
      return refuseReplay()
    }

    await sweepTokens(now)

    return tokens
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

      // A client stored by an earlier version can hold a redirect URI that
      // registration refuses now.
      if (redirectUriProblem(redirectUri) !== undefined) {
        return { kind: 'invalid', message: 'The redirect_uri of this client is not one Kelpie redirects to.' }
      }

      // The redirect URI is registered, but nobody has agreed to anything yet,
      // so these errors stop on a page here too and do not go to the client.
      const fail = (error: string, description: string): AuthorizeOutcome => ({
        kind: 'invalid',
        message: `${description}.`,
        error,
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
        state: parameters.state ?? null,
        expiresAt: new Date(now.getTime() + REQUEST_LIFETIME_MS),
      })

      return { kind: 'consent', requestId: request.id }
    },

    async getRequest(actor, id) {
      const session = requireSessionActor(actor)
      const request = await findAnswerableRequest(id, dependencies.now())
      const client =
        request === undefined ? undefined : await repository.findClientById(dependencies.db, request.clientRowId)

      if (request === undefined || client === undefined) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const memberships = await repository.listMembershipsForUser(dependencies.db, session.userId)
      const extraScopes = offeredExtraScopes(request.scopes as ApiKeyScope[])
      // A local redirect does not prove which program asked, so such a
      // request gets nothing ticked from an earlier approval: no sensitive
      // scope, and no workspace either. A ticked workspace gives no sensitive
      // scope, but with one click it would give a program that only names the
      // client every workspace the client has, and not the one workspace a
      // new app gets.
      const localClient = isLocalRedirectUri(request.redirectUri)
      // Read here and never taken from the request: what a connection holds
      // already is for the server to say, not for the client that wants more.
      // Only the grants of the signed-in person, and of those only the ones
      // to this client.
      const grants = (await repository.listGrantsForUser(dependencies.db, session.userId)).filter(
        ({ grant }) => grant.clientRowId === client.id,
      )

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
        extraScopes,
        localClient,
        workspaces: memberships.map((membership) => {
          const held = grants.find(({ grant }) => grant.workspaceId === membership.id)?.grant.scopes

          const heldScopes =
            held === undefined ? [] : extraScopes.filter((extra) => scopesCover(held as ApiKeyScope[], extra))

          return {
            id: membership.id,
            name: membership.name,
            role: parseRole(membership.role),
            connected: !localClient && held !== undefined,
            heldScopes: localClient ? [] : heldScopes,
            displayConnected: held !== undefined,
            displayHeldScopes: heldScopes,
          }
        }),
        expiresAt: request.expiresAt,
      }
    },

    async approve(actor, id, workspaceIds, scopes) {
      const session = requireSessionActor(actor)
      const now = dependencies.now()
      const request = await findAnswerableRequest(id, now)

      if (request === undefined) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const workspaces = [...new Set(workspaceIds)]

      if (workspaces.length === 0) {
        throw AppError.validationFailed('Choose at least one workspace', [
          { field: 'workspace_ids', message: 'Choose at least one workspace' },
        ])
      }

      // All or nothing: one workspace the user does not belong to refuses the
      // whole approval, so a page that sent a wrong id grants nothing.
      for (const workspaceId of workspaces) {
        const membership = await authRepository.findMembership(dependencies.db, workspaceId, session.userId)

        if (membership === undefined) {
          throw AppError.validationFailed('Choose workspaces you belong to', [
            { field: 'workspace_ids', message: 'You are not a member of one of these workspaces' },
          ])
        }
      }

      const chosen = [...new Set(scopes)]

      if (chosen.length === 0) {
        throw AppError.validationFailed('Allow at least one kind of access', [
          { field: 'scopes', message: 'Choose at least one scope' },
        ])
      }

      // The fixed list and not `offeredExtraScopes`: an extra the request
      // includes already is in `request.scopes`, or adds nothing.
      const unasked = chosen.filter(
        (scope) => !request.scopes.includes(scope) && !CONSENT_EXTRA_SCOPES.includes(scope),
      )

      if (unasked.length > 0) {
        throw AppError.validationFailed(
          'You can remove requested access and add an extra permission, not add other access',
          [{ field: 'scopes', message: `Not requested: ${unasked.join(', ')}` }],
        )
      }

      if (!(await repository.takeRequest(dependencies.db, request.id))) {
        throw AppError.notFound('This connection request has expired or was already answered')
      }

      const code = mintCode(newToken)

      await dependencies.db.transaction(async (tx) => {
        const connection = await repository.insertConnection(tx, {
          id: dependencies.createId('oauthConnection'),
          userId: session.userId,
          clientRowId: request.clientRowId,
        })

        // A grant that exists for the same client and workspace moves here, so
        // its old connection loses that workspace. An old connection left with
        // no grant is deleted below, and its tokens with it: approving again
        // ends the old tokens, and a narrower choice takes effect at once.
        for (const workspaceId of workspaces) {
          await repository.upsertGrant(tx, {
            id: dependencies.createId('oauthGrant'),
            workspaceId,
            userId: session.userId,
            clientRowId: request.clientRowId,
            connectionId: connection.id,
            scopes: chosen,
            updatedAt: now,
          })
        }

        await repository.deleteConnectionsWithoutGrants(tx)
        await repository.insertToken(tx, {
          id: dependencies.createId('oauthToken'),
          connectionId: connection.id,
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

      const request = await findAnswerableRequest(id, dependencies.now())

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
      const connection =
        record === undefined ? undefined : await repository.findConnection(dependencies.db, record.connectionId)

      // RFC 7009 §2.2: an unknown token, or one for another client, still
      // answers 200. Saying otherwise would tell a caller which tokens exist.
      if (record === undefined || connection === undefined || connection.clientRowId !== client.id) {
        return
      }

      // Revoking a refresh token ends the connection, in every workspace it
      // covers; an access token is just that one token.
      if (record.kind === 'refresh') {
        await repository.deleteConnectionById(dependencies.db, connection.id)
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
        connectionId: grant.connectionId,
        clientName: client.clientName,
        clientHost:
          client.kind === 'metadata_document'
            ? new URL(client.clientId).hostname
            : describeRedirectHost(client.redirectUris[0] ?? ''),
        workspaceId: grant.workspaceId,
        workspaceName,
        scopes: grant.scopes as ApiKeyScope[],
        extraScopes: sensitiveApiKeyScopesHeld(grant.scopes as ApiKeyScope[]),
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

      // The other workspaces of the connection stay. If this was the last one,
      // the connection and its tokens go.
      await repository.deleteConnectionsWithoutGrants(dependencies.db)
    },

    async revokeConnection(actor, id) {
      const session = requireSessionActor(actor)

      // Another user's connection answers 404, the same as one that never existed.
      if ((await repository.deleteConnection(dependencies.db, session.userId, id)) === 0) {
        throw AppError.notFound('Connected app not found')
      }
    },

    async removeMemberGrants(workspaceId, userId) {
      await repository.deleteGrantsForMember(dependencies.db, workspaceId, userId)
      await repository.deleteConnectionsWithoutGrants(dependencies.db)
    },
  }
}

import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'

import { checkOneOf, createdAt, moment, primaryId, updatedAt } from '../../lib/columns.ts'
import { users } from '../auth/schema.ts'
import { workspaces } from '../workspace/schema.ts'

/**
 * The authorization server's state.
 *
 * Every secret here is a SHA-256 hash, as sessions and API keys are: a code,
 * an access token, a refresh token and a client secret are only ever compared,
 * never used again, so none needs to be recoverable.
 */

/**
 * How a client identified itself. `registered` came through Dynamic Client
 * Registration and its `client_id` is ours. `metadata_document` is a Client ID
 * Metadata Document: its `client_id` is the HTTPS URL the document lives at,
 * and this row is a cache of that document.
 */
export const OAUTH_CLIENT_KINDS = ['registered', 'metadata_document'] as const

export type OAuthClientKind = (typeof OAUTH_CLIENT_KINDS)[number]

/** How a client proves itself at the token endpoint. `none` is a public client, relying on PKCE. */
export const OAUTH_TOKEN_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const

export type OAuthTokenAuthMethod = (typeof OAUTH_TOKEN_AUTH_METHODS)[number]

export const OAUTH_TOKEN_KINDS = ['code', 'access', 'refresh'] as const

export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number]

/** Deployment-wide, like a user: one client may be connected to many workspaces. */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: primaryId(),
    clientId: text('client_id').notNull().unique(),
    kind: text('kind').notNull(),
    clientName: text('client_name').notNull(),
    clientUri: text('client_uri'),
    logoUri: text('logo_uri'),
    redirectUris: text('redirect_uris').array().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    /** Null for a public client and for every metadata-document client. */
    clientSecretHash: text('client_secret_hash'),
    /** When a metadata document was last fetched. Null for a registered client. */
    metadataFetchedAt: moment('metadata_fetched_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    checkOneOf('oauth_clients_kind_check', table.kind, OAUTH_CLIENT_KINDS),
    checkOneOf('oauth_clients_auth_method_check', table.tokenEndpointAuthMethod, OAUTH_TOKEN_AUTH_METHODS),
  ],
)

/**
 * An authorize request waiting for the consent page. Not tied to a user until
 * someone signed in answers it; deleted when they do, or when it expires.
 */
export const oauthRequests = pgTable(
  'oauth_requests',
  {
    id: primaryId(),
    clientRowId: text('client_row_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scopes: text('scopes').array().notNull(),
    resource: text('resource').notNull(),
    /** The client's `state`, echoed on the redirect. Opaque to us. */
    state: text('state'),
    expiresAt: moment('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('oauth_requests_expires_idx').on(table.expiresAt)],
)

/**
 * One user's approval of one client for one workspace. Approving the same
 * client for the same workspace again updates this row rather than adding one,
 * so "Connected apps" lists each connection once.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientRowId: text('client_row_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** Never empty: an empty list on an API key means full access, and a grant must never mean that. */
    scopes: text('scopes').array().notNull(),
    lastUsedAt: moment('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('oauth_grants_connection_idx').on(table.workspaceId, table.userId, table.clientRowId),
    index('oauth_grants_user_idx').on(table.userId),
    check('oauth_grants_scopes_nonempty', sql`cardinality(${table.scopes}) > 0`),
  ],
)

/**
 * Codes, access tokens and refresh tokens, all under a grant, so revoking the
 * grant revokes every one of them through the cascade.
 */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: primaryId(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** The audience (RFC 8707). Always this deployment's `/mcp` URI today. */
    resource: text('resource').notNull(),
    scopes: text('scopes').array().notNull(),
    /** A code only: the redirect URI the token request must repeat. */
    redirectUri: text('redirect_uri'),
    /** A code only: the S256 PKCE challenge the token request must answer. */
    codeChallenge: text('code_challenge'),
    expiresAt: moment('expires_at').notNull(),
    /**
     * A code or a refresh token is single use. Set when it is spent; a second
     * spend is a replay and revokes the grant.
     */
    usedAt: moment('used_at'),
    createdAt: createdAt(),
  },
  (table) => [
    checkOneOf('oauth_tokens_kind_check', table.kind, OAUTH_TOKEN_KINDS),
    index('oauth_tokens_grant_idx').on(table.grantId),
    index('oauth_tokens_expires_idx').on(table.expiresAt),
  ],
)

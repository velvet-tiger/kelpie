import { z } from 'zod'

import { API_KEY_SCOPES } from './apiKeyScopes.ts'
import type { ApiKeyScope } from './apiKeyScopes.ts'
import { MEMBER_ROLES } from './values.ts'
import type { MemberRole } from './values.ts'
import { idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'

/**
 * Wire shapes for the session-only OAuth endpoints under `/v1/oauth`: the
 * consent page's pending request, and the "Connected apps" list.
 *
 * The OAuth protocol endpoints themselves (`/oauth/authorize`, `/oauth/token`,
 * `/oauth/register`, `/oauth/revoke`) are not here. Their shapes are fixed by
 * the OAuth standards, and only MCP clients call them.
 */

/** A workspace the signed-in user may connect the client to. */
export interface OAuthWorkspaceChoice {
  readonly id: string
  readonly name: string
  readonly role: MemberRole
}

/** A pending authorization request, as the consent page shows it. */
export interface OAuthRequest {
  readonly id: string
  readonly clientName: string
  /**
   * The host the client redirects to. A registered name is not proof of who
   * the client is; the host is, so the consent page shows both.
   */
  readonly clientHost: string
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly scopes: readonly ApiKeyScope[]
  readonly workspaces: readonly OAuthWorkspaceChoice[]
  readonly expiresAt: Date
}

/** Where the browser goes after the user answers the consent page. */
export interface OAuthDecision {
  readonly redirectUrl: string
}

/** One connected app: a client the user approved for one workspace. */
export interface OAuthGrant {
  readonly id: string
  readonly clientName: string
  readonly clientHost: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly scopes: readonly ApiKeyScope[]
  readonly lastUsedAt: Date | null
  readonly createdAt: Date
}

const oauthRequestWireSchema = z.object({
  id: idSchema,
  client_name: z.string(),
  client_host: z.string(),
  client_uri: z.string().nullable(),
  logo_uri: z.string().nullable(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  workspaces: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      role: z.enum(MEMBER_ROLES),
    }),
  ),
  expires_at: timestampSchema,
})

export const oauthRequestSchema: z.ZodType<OAuthRequest, unknown> = oauthRequestWireSchema.transform(
  (wire): OAuthRequest => ({
    id: wire.id,
    clientName: wire.client_name,
    clientHost: wire.client_host,
    clientUri: wire.client_uri,
    logoUri: wire.logo_uri,
    scopes: wire.scopes,
    workspaces: wire.workspaces,
    expiresAt: wire.expires_at,
  }),
)

export const oauthDecisionSchema: z.ZodType<OAuthDecision, unknown> = z
  .object({ redirect_url: z.string() })
  .transform((wire): OAuthDecision => ({ redirectUrl: wire.redirect_url }))

export const oauthGrantSchema: z.ZodType<OAuthGrant, unknown> = z
  .object({
    id: idSchema,
    client_name: z.string(),
    client_host: z.string(),
    workspace_id: idSchema,
    workspace_name: z.string(),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    last_used_at: nullableTimestampSchema,
    created_at: timestampSchema,
  })
  .transform(
    (wire): OAuthGrant => ({
      id: wire.id,
      clientName: wire.client_name,
      clientHost: wire.client_host,
      workspaceId: wire.workspace_id,
      workspaceName: wire.workspace_name,
      scopes: wire.scopes,
      lastUsedAt: wire.last_used_at,
      createdAt: wire.created_at,
    }),
  )

export interface ApproveOAuthRequestInput {
  readonly workspaceId: string
  /** At least one. The user may remove requested scopes, never add others. */
  readonly scopes: readonly ApiKeyScope[]
}

export function approveOAuthRequestBody(input: ApproveOAuthRequestInput): unknown {
  return { workspace_id: input.workspaceId, scopes: input.scopes }
}

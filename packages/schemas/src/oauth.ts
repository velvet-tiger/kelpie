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
  /**
   * The request's `extraScopes` that this client already has in this
   * workspace, from an earlier approval by the same person. The server
   * decides this. Empty when the client is not connected to the workspace.
   */
  readonly heldScopes: readonly ApiKeyScope[]
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
  /** What the client asked for. */
  readonly scopes: readonly ApiKeyScope[]
  /**
   * The scopes the consent page shows apart, with what each one risks: every
   * requested scope that gives a sensitive power, then the ones the server
   * always offers. A scope here may also be in `scopes`. Each starts clear,
   * unless every selected workspace has it in `heldScopes`.
   */
  readonly extraScopes: readonly ApiKeyScope[]
  readonly workspaces: readonly OAuthWorkspaceChoice[]
  readonly expiresAt: Date
}

/** Where the browser goes after the user answers the consent page. */
export interface OAuthDecision {
  readonly redirectUrl: string
}

/**
 * One workspace of a connected app: a client the user approved for it.
 *
 * `connectionId` is the approval it came from. Grants with the same one were
 * approved together and share their tokens.
 */
export interface OAuthGrant {
  readonly id: string
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

const oauthRequestWireSchema = z.object({
  id: idSchema,
  client_name: z.string(),
  client_host: z.string(),
  client_uri: z.string().nullable(),
  logo_uri: z.string().nullable(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  extra_scopes: z.array(z.enum(API_KEY_SCOPES)),
  workspaces: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      role: z.enum(MEMBER_ROLES),
      held_scopes: z.array(z.enum(API_KEY_SCOPES)),
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
    extraScopes: wire.extra_scopes,
    workspaces: wire.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      heldScopes: workspace.held_scopes,
    })),
    expiresAt: wire.expires_at,
  }),
)

export const oauthDecisionSchema: z.ZodType<OAuthDecision, unknown> = z
  .object({ redirect_url: z.string() })
  .transform((wire): OAuthDecision => ({ redirectUrl: wire.redirect_url }))

export const oauthGrantSchema: z.ZodType<OAuthGrant, unknown> = z
  .object({
    id: idSchema,
    connection_id: idSchema,
    client_name: z.string(),
    client_host: z.string(),
    workspace_id: idSchema,
    workspace_name: z.string(),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    extra_scopes: z.array(z.enum(API_KEY_SCOPES)),
    last_used_at: nullableTimestampSchema,
    created_at: timestampSchema,
  })
  .transform(
    (wire): OAuthGrant => ({
      id: wire.id,
      connectionId: wire.connection_id,
      clientName: wire.client_name,
      clientHost: wire.client_host,
      workspaceId: wire.workspace_id,
      workspaceName: wire.workspace_name,
      scopes: wire.scopes,
      extraScopes: wire.extra_scopes,
      lastUsedAt: wire.last_used_at,
      createdAt: wire.created_at,
    }),
  )

export interface ApproveOAuthRequestInput {
  /** At least one. One connection then covers each of them. */
  readonly workspaceIds: readonly string[]
  /**
   * At least one. The user may remove requested scopes, and may add any of
   * the request's `extraScopes`. The server refuses every other scope. The
   * connection then has these scopes and no others: an approval replaces
   * what an earlier one gave.
   */
  readonly scopes: readonly ApiKeyScope[]
}

export function approveOAuthRequestBody(input: ApproveOAuthRequestInput): unknown {
  return { workspace_ids: input.workspaceIds, scopes: input.scopes }
}

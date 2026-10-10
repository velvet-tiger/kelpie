import { API_KEY_SCOPES } from '@kelpie/schemas'
import type { Context, Handler, Hono } from 'hono'
import { z } from 'zod'

import { readJsonBody, withholdFromReplay } from '../../lib/http.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { OAuthClientError, registrationBody } from './clients.ts'
import { OAUTH_TOKEN_AUTH_METHODS } from './schema.ts'
import { DEFAULT_SCOPES, OAuthError } from './service.ts'
import type { ClientCredentials, ConsentView, GrantView, OAuthService } from './service.ts'
import {
  MAX_ID_LENGTH,
  MAX_LIST_ITEMS,
} from '../../lib/fieldLimits.ts'

/**
 * The OAuth surfaces.
 *
 * Two kinds. The protocol endpoints (`/oauth/*`, `/.well-known/*`) sit outside
 * `/v1`: the OAuth standards fix their shapes, their callers are OAuth
 * libraries, and a browser reaches `/oauth/authorize` by redirect. The consent
 * page's endpoints sit under `/v1/oauth`, because that page is part of the UI,
 * and the UI uses the public API.
 */

/** Where the UI's consent page lives. Outside `/oauth`, which the page fallback leaves to the API. */
export const CONSENT_PAGE_PATH = '/consent'

// Protocol endpoints

/**
 * The OAuth error body. `Cache-Control: no-store` on every token-endpoint
 * answer, success or failure (RFC 6749 §5.1).
 */
function oauthErrorResponse(context: Context, error: OAuthError, viaBasic: boolean): Response {
  context.header('Cache-Control', 'no-store')

  if (error.status === 401 && viaBasic) {
    context.header('WWW-Authenticate', 'Basic realm="kelpie"')
  }

  return context.json({ error: error.error, error_description: error.description }, error.status)
}

/** The form fields of an `application/x-www-form-urlencoded` body, strings only. */
async function readForm(context: Context): Promise<Record<string, string | undefined>> {
  const contentType = context.req.header('Content-Type') ?? ''

  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthError(400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded')
  }

  const params = new URLSearchParams(await context.req.text())
  const form: Record<string, string | undefined> = {}

  for (const [name, value] of params) {
    // RFC 6749 §3.1: a parameter sent twice is an error, not a choice.
    if (form[name] !== undefined) {
      throw new OAuthError(400, 'invalid_request', `The parameter ${name} appears more than once`)
    }

    form[name] = value
  }

  return form
}

/** The scheme of an `Authorization` header, when it is `Basic`, and what follows it. */
const BASIC_AUTHORIZATION = /^Basic(?:\s+(?<value>.*))?$/isu

/** What `Buffer.from(value, 'base64')` reads without dropping a character. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u

/**
 * True when the client tried HTTP Basic, whether or not what it sent can be
 * read. RFC 6749 §5.2: a `401` to such a client names the scheme in
 * `WWW-Authenticate`, so this is asked before the credentials are parsed.
 */
function attemptedBasic(context: Context): boolean {
  return BASIC_AUTHORIZATION.test((context.req.header('Authorization') ?? '').trim())
}

/** RFC 6749 §5.2: credentials that cannot be read are `401 invalid_client`, as wrong ones are. */
function malformedBasicCredentials(): OAuthError {
  return new OAuthError(401, 'invalid_client', 'The Basic credentials are malformed')
}

/**
 * One half of the Basic credentials. RFC 6749 §2.3.1: the id and secret are
 * form-encoded before they are base64-encoded, so each half is decoded again.
 *
 * @throws OAuthError 401 `invalid_client` for a percent sign that starts no
 *   valid escape, or an escape that is not UTF-8.
 */
function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' '))
  } catch (error: unknown) {
    if (error instanceof URIError) {
      throw malformedBasicCredentials()
    }

    throw error
  }
}

/**
 * The client id and secret from an `Authorization` header, or undefined when
 * the header is absent or is another scheme, and the form is read.
 *
 * @throws OAuthError 401 `invalid_client` when the header says Basic and the
 *   rest is not base64 of UTF-8 text, has no colon, has a half that is not
 *   form-encoded, or has an empty client id.
 */
function parseBasicCredentials(
  header: string | undefined,
): { readonly clientId: string; readonly clientSecret: string } | undefined {
  const match = header === undefined ? null : BASIC_AUTHORIZATION.exec(header.trim())

  if (match === null) {
    return undefined
  }

  const encoded = match.groups?.value?.trim() ?? ''

  if (!BASE64.test(encoded)) {
    throw malformedBasicCredentials()
  }

  let decoded: string

  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'))
  } catch (error: unknown) {
    // What a fatal decoder throws for bytes that are not UTF-8.
    if (error instanceof TypeError) {
      throw malformedBasicCredentials()
    }

    throw error
  }

  const separator = decoded.indexOf(':')

  if (separator < 0) {
    throw malformedBasicCredentials()
  }

  const clientId = decodeFormComponent(decoded.slice(0, separator))
  const clientSecret = decodeFormComponent(decoded.slice(separator + 1))

  if (clientId.length === 0) {
    throw malformedBasicCredentials()
  }

  return { clientId, clientSecret }
}

/** The client's credentials from `Authorization: Basic` or the form. */
function readClientCredentials(context: Context, form: Readonly<Record<string, string | undefined>>): ClientCredentials {
  const basic = parseBasicCredentials(context.req.header('Authorization'))

  if (basic === undefined) {
    return { clientId: form.client_id, clientSecret: form.client_secret, viaBasic: false }
  }

  if (form.client_id !== undefined && form.client_id !== basic.clientId) {
    throw new OAuthError(401, 'invalid_client', 'client_id in the form does not match the Basic credentials')
  }

  return { ...basic, viaBasic: true }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The page a person sees when an authorize request cannot go on: the client or
 * its redirect URI cannot be trusted (RFC 6749 §4.1.2.1), or the request is
 * wrong in another way. The error stops here each time. Nobody has agreed to
 * anything yet, and sending the browser on to a redirect URI that anybody
 * could have registered would make this deployment an open redirector
 * (RFC 9700 §4.11).
 *
 * `error` is the OAuth error code, shown for the developer of the client, who
 * no longer receives it at the redirect URI. Every value is escaped: the
 * message can repeat a parameter of the request.
 */
function invalidRequestPage(context: Context, message: string, error: string | undefined): Response {
  context.header('Cache-Control', 'no-store')

  return context.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection request not valid</title>` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
      `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">` +
      `<h1 style="font-size: 1.25rem">This connection request is not valid</h1>` +
      `<p>${escapeHtml(message)}</p>` +
      (error === undefined ? '' : `<p>Error code: <code>${escapeHtml(error)}</code></p>`) +
      `<p>Go back to the app that sent you here and try to connect again.</p>` +
      `</body></html>`,
    400,
  )
}

/** Discovery documents are read by browsers too (the MCP Inspector, say), and hold nothing private. */
function discoveryResponse(context: Context, body: Record<string, unknown>): Response {
  context.header('Access-Control-Allow-Origin', '*')
  context.header('Cache-Control', 'public, max-age=3600')

  return context.json(body)
}

export interface OAuthProtocolHandlers {
  readonly protectedResource: Handler
  readonly authorizationServer: Handler
  readonly authorize: Handler
  readonly token: Handler
  readonly register: Handler
  readonly revoke: Handler
}

export function createProtocolHandlers(service: OAuthService): OAuthProtocolHandlers {
  const { endpoints } = service

  return {
    // RFC 9728.
    protectedResource: (context) =>
      discoveryResponse(context, {
        resource: endpoints.resource,
        authorization_servers: [endpoints.issuer],
        scopes_supported: DEFAULT_SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'Kelpie',
      }),

    // RFC 8414.
    authorizationServer: (context) =>
      discoveryResponse(context, {
        issuer: endpoints.issuer,
        authorization_endpoint: endpoints.authorizationEndpoint,
        token_endpoint: endpoints.tokenEndpoint,
        registration_endpoint: endpoints.registrationEndpoint,
        revocation_endpoint: endpoints.revocationEndpoint,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: OAUTH_TOKEN_AUTH_METHODS,
        revocation_endpoint_auth_methods_supported: OAUTH_TOKEN_AUTH_METHODS,
        scopes_supported: API_KEY_SCOPES,
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }),

    authorize: async (context) => {
      const outcome = await service.authorize(context.req.query())

      if (outcome.kind === 'invalid') {
        return invalidRequestPage(context, outcome.message, outcome.error)
      }

      // Relative, so the browser stays on the origin it came in on.
      return context.redirect(`${CONSENT_PAGE_PATH}/${outcome.requestId}`, 302)
    },

    token: async (context) => {
      const viaBasic = attemptedBasic(context)

      try {
        const form = await readForm(context)
        const credentials = readClientCredentials(context, form)
        const tokens = await service.token(form, credentials)

        context.header('Cache-Control', 'no-store')

        return context.json(tokens)
      } catch (error: unknown) {
        if (error instanceof OAuthError) {
          return oauthErrorResponse(context, error, viaBasic)
        }

        throw error
      }
    },

    register: async (context) => {
      try {
        const raw: unknown = await context.req.json().catch(() => {
          throw new OAuthClientError('invalid_client_metadata', 'The body must be JSON')
        })
        const parsed = registrationBody.safeParse(raw)

        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const field = issue === undefined ? 'body' : issue.path.join('.')

          throw new OAuthClientError('invalid_client_metadata', `${field}: ${issue?.message ?? 'is not valid'}`)
        }

        context.header('Cache-Control', 'no-store')

        return context.json(await service.register(parsed.data), 201)
      } catch (error: unknown) {
        if (error instanceof OAuthClientError) {
          return context.json({ error: error.code, error_description: error.message }, 400)
        }

        throw error
      }
    },

    // RFC 7009.
    revoke: async (context) => {
      const viaBasic = attemptedBasic(context)

      try {
        const form = await readForm(context)
        const credentials = readClientCredentials(context, form)

        await service.revoke(form, credentials)

        return context.body(null, 200)
      } catch (error: unknown) {
        if (error instanceof OAuthError) {
          return oauthErrorResponse(context, error, viaBasic)
        }

        throw error
      }
    },
  }
}

// The consent page and connected apps, under /v1

const approveBody = z.object({
  workspace_ids: z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MAX_LIST_ITEMS),
  scopes: z.array(z.enum(API_KEY_SCOPES)).max(MAX_LIST_ITEMS),
})

function requestResponse(view: ConsentView): Record<string, unknown> {
  return {
    id: view.id,
    client_name: view.clientName,
    client_host: view.clientHost,
    client_uri: view.clientUri,
    logo_uri: view.logoUri,
    scopes: view.scopes,
    extra_scopes: view.extraScopes,
    local_client: view.localClient,
    workspaces: view.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      connected: workspace.connected,
      held_scopes: workspace.heldScopes,
      display_connected: workspace.displayConnected,
      display_held_scopes: workspace.displayHeldScopes,
    })),
    expires_at: view.expiresAt.toISOString(),
  }
}

function grantResponse(grant: GrantView): Record<string, unknown> {
  return {
    id: grant.id,
    connection_id: grant.connectionId,
    client_name: grant.clientName,
    client_host: grant.clientHost,
    workspace_id: grant.workspaceId,
    workspace_name: grant.workspaceName,
    scopes: grant.scopes,
    extra_scopes: grant.extraScopes,
    last_used_at: grant.lastUsedAt === null ? null : grant.lastUsedAt.toISOString(),
    created_at: grant.createdAt.toISOString(),
  }
}

export interface OAuthRoutesDependencies extends CredentialDependencies {
  readonly service: OAuthService
}

/**
 * Session only, like `POST /v1/auth/workspace`. The service refuses an API key
 * or an OAuth token with `403`: a credential that mints credentials is an
 * escalation, which is also why MCP has no tools for these.
 */
export function mountOAuthRoutes(router: Hono, dependencies: OAuthRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  router.get('/oauth/requests/:id', async (context) => {
    const view = await dependencies.service.getRequest(await requireActor(context), context.req.param('id'))

    return context.json(requestResponse(view))
  })

  router.post('/oauth/requests/:id/approve', async (context) => {
    const actor = await requireActor(context)
    const body = await readJsonBody(context, approveBody)
    const redirectUrl = await dependencies.service.approve(
      actor,
      context.req.param('id'),
      body.workspace_ids,
      body.scopes,
    )

    // The URL carries the authorization code.
    withholdFromReplay(context)

    return context.json({ redirect_url: redirectUrl })
  })

  router.post('/oauth/requests/:id/deny', async (context) => {
    const redirectUrl = await dependencies.service.deny(await requireActor(context), context.req.param('id'))

    return context.json({ redirect_url: redirectUrl })
  })

  router.get('/oauth/grants', async (context) => {
    const grants = await dependencies.service.listGrants(await requireActor(context))

    return context.json({ data: grants.map(grantResponse), next_cursor: null })
  })

  router.delete('/oauth/grants/:id', async (context) => {
    await dependencies.service.revokeGrant(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.delete('/oauth/connections/:id', async (context) => {
    await dependencies.service.revokeConnection(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

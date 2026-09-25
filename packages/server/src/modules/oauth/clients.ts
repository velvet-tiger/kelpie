import { z } from 'zod'

import { BlockedEgressError } from '../../lib/egress.ts'
import type { EgressGuard } from '../../lib/egress.ts'
import { OAUTH_TOKEN_AUTH_METHODS } from './schema.ts'
import type { OAuthTokenAuthMethod } from './schema.ts'

/**
 * Who a client is, and where it may be sent.
 *
 * Two ways in. Dynamic Client Registration (RFC 7591) creates a row whose
 * `client_id` is ours. A Client ID Metadata Document is an HTTPS URL used as
 * the `client_id` itself; Kelpie fetches the JSON at that URL and trusts the
 * redirect URIs it lists, because only whoever controls that URL could have
 * written them.
 */

/** Schemes that would run code or read local data if a browser followed them. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ws:', 'wss:'])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A client error the OAuth standards give a code to. */
export type OAuthClientErrorCode = 'invalid_client_metadata' | 'invalid_redirect_uri' | 'invalid_client'

export class OAuthClientError extends Error {
  readonly code: OAuthClientErrorCode

  constructor(code: OAuthClientErrorCode, message: string) {
    super(message)
    this.name = 'OAuthClientError'
    this.code = code
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * The redirect URIs a client may register.
 *
 * HTTPS anywhere. Plain HTTP only on a loopback address, which is what a CLI or
 * desktop client listens on (RFC 8252 §7.3). A private-use scheme
 * (`cursor://…`) for an app that registers one with the operating system
 * (RFC 8252 §7.1). Never a scheme a browser would execute, never a fragment,
 * never embedded credentials.
 */
export function redirectUriProblem(value: string): string | undefined {
  const url = parseUrl(value)

  if (url === undefined) {
    return `"${value}" is not an absolute URL`
  }

  if (url.hash.length > 0 || value.includes('#')) {
    return `"${value}" has a fragment, which a redirect URI may not`
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return `"${value}" carries credentials`
  }

  if (FORBIDDEN_SCHEMES.has(url.protocol)) {
    return `"${value}" uses the ${url.protocol} scheme, which a redirect URI may not`
  }

  if (url.protocol === 'http:' && !isLoopback(url)) {
    return `"${value}" is plain HTTP on a host other than a loopback address`
  }

  return undefined
}

/**
 * Whether a redirect URI in an authorize request matches a registered one.
 *
 * Exact string match, as OAuth 2.1 requires, with the one exception RFC 8252
 * §7.3 makes: a loopback redirect may use any port, because a native client
 * picks a free one at run time.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) {
    return true
  }

  const asked = parseUrl(requested)

  if (asked === undefined || !isLoopback(asked)) {
    return false
  }

  return registered.some((entry) => {
    const candidate = parseUrl(entry)

    return (
      candidate !== undefined &&
      isLoopback(candidate) &&
      candidate.hostname === asked.hostname &&
      candidate.pathname === asked.pathname &&
      candidate.search === asked.search
    )
  })
}

/**
 * What the consent page shows as the client's address. A client name is
 * whatever the client said; the host is what the browser will actually be
 * sent to, so it is the part a person can check.
 */
export function describeRedirectHost(redirectUri: string): string {
  const url = parseUrl(redirectUri)

  if (url === undefined) {
    return redirectUri
  }

  if (isLoopback(url)) {
    return 'an app on this computer'
  }

  if (url.protocol === 'https:') {
    return url.hostname
  }

  return url.protocol.slice(0, -1)
}

// Dynamic Client Registration

const optionalHttpsUrl = z
  .string()
  .max(2048)
  .refine((value) => parseUrl(value)?.protocol === 'https:', { message: 'must be an https URL' })
  .optional()

export const registrationBody = z.object({
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_uri: optionalHttpsUrl,
  logo_uri: optionalHttpsUrl,
  token_endpoint_auth_method: z.enum(OAUTH_TOKEN_AUTH_METHODS).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
})

export type RegistrationBody = z.infer<typeof registrationBody>

export const SUPPORTED_GRANT_TYPES: readonly string[] = ['authorization_code', 'refresh_token']

export interface ValidatedRegistration {
  readonly redirectUris: readonly string[]
  readonly clientName: string
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly tokenEndpointAuthMethod: OAuthTokenAuthMethod
}

/**
 * @throws OAuthClientError for a redirect URI Kelpie will not send a browser
 *   to, or a grant or response type it does not issue.
 */
export function validateRegistration(body: RegistrationBody): ValidatedRegistration {
  for (const uri of body.redirect_uris) {
    const problem = redirectUriProblem(uri)

    if (problem !== undefined) {
      throw new OAuthClientError('invalid_redirect_uri', problem)
    }
  }

  const unsupportedGrant = (body.grant_types ?? []).find((grant) => !SUPPORTED_GRANT_TYPES.includes(grant))

  if (unsupportedGrant !== undefined) {
    throw new OAuthClientError('invalid_client_metadata', `The grant type "${unsupportedGrant}" is not supported`)
  }

  const unsupportedResponse = (body.response_types ?? []).find((type) => type !== 'code')

  if (unsupportedResponse !== undefined) {
    throw new OAuthClientError(
      'invalid_client_metadata',
      `The response type "${unsupportedResponse}" is not supported`,
    )
  }

  const firstRedirect = body.redirect_uris[0] ?? ''

  return {
    redirectUris: body.redirect_uris,
    clientName: body.client_name ?? describeRedirectHost(firstRedirect),
    clientUri: body.client_uri ?? null,
    logoUri: body.logo_uri ?? null,
    // RFC 7591 §2: omitted means `client_secret_basic`.
    tokenEndpointAuthMethod: body.token_endpoint_auth_method ?? 'client_secret_basic',
  }
}

// Client ID Metadata Documents

/** How long a fetched document is trusted before it is fetched again. */
export const METADATA_DOCUMENT_TTL_MS = 24 * 60 * 60_000

const METADATA_FETCH_TIMEOUT_MS = 5_000
const METADATA_MAX_BYTES = 64 * 1024

/**
 * True when a `client_id` is a metadata document URL rather than an id Kelpie
 * issued. The draft requires HTTPS and a path, so a bare origin is not one.
 */
export function isMetadataDocumentClientId(clientId: string): boolean {
  const url = parseUrl(clientId)

  return url !== undefined && url.protocol === 'https:' && url.pathname.length > 1
}

const metadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_uri: z.string().max(2048).optional(),
  logo_uri: z.string().max(2048).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  token_endpoint_auth_method: z.string().optional(),
})

export interface FetchedClientMetadata {
  readonly clientName: string
  readonly clientUri: string | null
  readonly logoUri: string | null
  readonly redirectUris: readonly string[]
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** Reads at most `limit` bytes, so a hostile document cannot exhaust memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()

  if (reader === undefined) {
    return ''
  }

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    total += value.byteLength

    if (total > limit) {
      await reader.cancel()
      throw new OAuthClientError('invalid_client', 'The client metadata document is too large')
    }

    chunks.push(value)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function httpsOrNull(value: string | undefined): string | null {
  return value !== undefined && parseUrl(value)?.protocol === 'https:' ? value : null
}

/**
 * Fetches and checks a Client ID Metadata Document.
 *
 * The URL is one a stranger chose, so the request goes through the same
 * egress guard as a webhook delivery, follows no redirect, gives up after five
 * seconds, and reads at most 64 KB.
 *
 * @throws OAuthClientError when the document cannot be fetched, is not valid,
 *   names a different `client_id`, or asks for a client authentication method
 *   Kelpie does not support for metadata-document clients.
 */
export async function fetchClientMetadata(
  clientId: string,
  dependencies: { readonly egress: EgressGuard; readonly fetch: Fetch },
): Promise<FetchedClientMetadata> {
  try {
    await dependencies.egress.check(clientId)
  } catch (error: unknown) {
    if (error instanceof BlockedEgressError) {
      throw new OAuthClientError('invalid_client', 'The client metadata document is on a private address')
    }

    throw error
  }

  let response: Response

  try {
    response = await dependencies.fetch(clientId, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new OAuthClientError('invalid_client', 'The client metadata document could not be fetched')
  }

  if (response.status !== 200) {
    throw new OAuthClientError(
      'invalid_client',
      `The client metadata document answered ${String(response.status)}`,
    )
  }

  let raw: unknown

  try {
    raw = JSON.parse(await readCapped(response, METADATA_MAX_BYTES))
  } catch (error: unknown) {
    if (error instanceof OAuthClientError) {
      throw error
    }

    throw new OAuthClientError('invalid_client', 'The client metadata document is not JSON')
  }

  const parsed = metadataDocument.safeParse(raw)

  if (!parsed.success) {
    throw new OAuthClientError('invalid_client', 'The client metadata document is missing required fields')
  }

  const document = parsed.data

  // The document must claim the URL it was fetched from. Anything else would
  // let one site's document stand in for another client.
  if (document.client_id !== clientId) {
    throw new OAuthClientError('invalid_client', 'The client metadata document names a different client_id')
  }

  // A document cannot hold a shared secret, and Kelpie does not verify
  // private_key_jwt, so a metadata-document client is always public.
  if (document.token_endpoint_auth_method !== undefined && document.token_endpoint_auth_method !== 'none') {
    throw new OAuthClientError(
      'invalid_client',
      `The token endpoint auth method "${document.token_endpoint_auth_method}" is not supported`,
    )
  }

  for (const uri of document.redirect_uris) {
    const problem = redirectUriProblem(uri)

    if (problem !== undefined) {
      throw new OAuthClientError('invalid_client', problem)
    }
  }

  return {
    clientName: document.client_name ?? new URL(clientId).hostname,
    clientUri: httpsOrNull(document.client_uri),
    logoUri: httpsOrNull(document.logo_uri),
    redirectUris: document.redirect_uris,
  }
}

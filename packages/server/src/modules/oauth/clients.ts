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

/**
 * Private-use schemes of desktop MCP clients that have no dot in them. Each
 * one opens the app that registered it with the operating system, and no
 * browser gives any of them a meaning of its own. A scheme goes here only when
 * a real client redirects to it.
 */
const NATIVE_APP_SCHEMES = new Set(['cursor:', 'vscode:', 'vscode-insiders:', 'windsurf:'])

/**
 * A private-use scheme in the form RFC 8252 §7.1 asks for: a domain name the
 * app's maker controls, reversed, such as `com.example.app`. The dot is the
 * point. No scheme that a browser or an operating system handles itself has
 * one, so a scheme with a dot can only be one that an app registered.
 * `URL.protocol` is lower case already and ends with the colon.
 */
const REVERSE_DOMAIN_SCHEME = /^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+:$/u

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A client error the OAuth standards give a code to. */
export type OAuthClientErrorCode = 'invalid_client_metadata' | 'invalid_redirect_uri' | 'invalid_client'

export class OAuthClientError extends Error {
  readonly code: OAuthClientErrorCode
  /**
   * What went wrong, for the server log only. Set when `message` must not say:
   * the caller of an unauthenticated endpoint reads `message`, and the detail
   * would tell it what a host of its choice answered.
   */
  readonly logReason: string | undefined

  constructor(code: OAuthClientErrorCode, message: string, logReason?: string) {
    super(message)
    this.name = 'OAuthClientError'
    this.code = code
    this.logReason = logReason
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

function isPrivateUseScheme(protocol: string): boolean {
  return NATIVE_APP_SCHEMES.has(protocol) || REVERSE_DOMAIN_SCHEME.test(protocol)
}

/**
 * True when a redirect URI goes to a program on the person's computer and not
 * to a site: every redirect that is not `https:`.
 *
 * `redirectUriProblem` allows two kinds besides HTTPS, and neither says which
 * program asked. A loopback redirect matches on any port
 * (`redirectUriMatches`), so any program can open an authorize request with
 * the `client_id` of a native client and a port of its own. A private-use
 * scheme such as `cursor://callback` belongs to whichever program registered
 * it with the operating system, and a second program can do that too. An
 * HTTPS redirect is the only kind that one party controls.
 *
 * A request with a local redirect is told nothing that would tick a box for
 * it. Written as "not HTTPS" and not as a list of the local kinds, so a kind
 * that `redirectUriProblem` allows later is local until somebody decides
 * otherwise. A value that is not a URL is local for the same reason.
 */
export function isLocalRedirectUri(value: string): boolean {
  return parseUrl(value)?.protocol !== 'https:'
}

/**
 * The redirect URIs a client may register, and the ones a browser may be sent
 * to. The service asks again before each redirect, because a row stored by an
 * earlier version can hold a URI that this rule refuses.
 *
 * Three kinds are allowed and every other scheme is refused. HTTPS anywhere.
 * Plain HTTP only on a loopback address, which is what a CLI or desktop client
 * listens on (RFC 8252 §7.3). A private-use scheme for an app that registers
 * one with the operating system (RFC 8252 §7.1): a reverse domain name such as
 * `com.example.app:/callback`, or one of `NATIVE_APP_SCHEMES`. A scheme that a
 * browser would run or read local data through (`javascript:`, `data:`,
 * `file:` and the like) is none of the three, so it needs no list of its own.
 * Never a fragment, never embedded credentials.
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

  if (url.protocol === 'https:' || isPrivateUseScheme(url.protocol)) {
    return undefined
  }

  if (url.protocol === 'http:') {
    return isLoopback(url) ? undefined : `"${value}" is plain HTTP on a host other than a loopback address`
  }

  return `"${value}" uses the ${url.protocol} scheme, which a redirect URI may not`
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

/**
 * The one message for every way a metadata document can fail.
 *
 * `/oauth/authorize` takes no credential, so anybody can make the server ask
 * an HTTPS URL for a document. A message that said "answered 404" or "is not
 * JSON" would tell that caller whether a host that only the server can reach
 * is there, and what it said. So the caller reads this sentence whatever
 * happened, and the reason goes to the server log.
 */
export const CLIENT_METADATA_REFUSED =
  'The client metadata document for this client_id could not be used. It must be at a public HTTPS address, ' +
  'answer 200 with JSON, name its own URL as client_id, and list redirect URIs that are allowed.'

function metadataRefused(logReason: string): OAuthClientError {
  return new OAuthClientError('invalid_client', CLIENT_METADATA_REFUSED, logReason)
}

/**
 * The name and message of a failed request. Never anything the host sent as a
 * body. The message of a `BlockedEgressError` leaves out the address the
 * guard refused; it is added here because this text goes to the log only.
 */
function describeFailure(error: Error): string {
  const refused = error instanceof BlockedEgressError ? ` (${error.address})` : ''

  return `${error.name}: ${error.message}${refused}`
}

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
      throw metadataRefused(`the document is larger than ${String(limit)} bytes`)
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
 * seconds, and reads at most 64 KB. `dependencies.fetch` must be the guard's
 * own `fetch`, which connects only to an address the guard accepted.
 *
 * @throws OAuthClientError when the document cannot be fetched, is not valid,
 *   names a different `client_id`, or asks for a client authentication method
 *   Kelpie does not support for metadata-document clients. The message is
 *   `CLIENT_METADATA_REFUSED` each time, and `logReason` says which it was.
 */
export async function fetchClientMetadata(
  clientId: string,
  dependencies: { readonly egress: EgressGuard; readonly fetch: Fetch },
): Promise<FetchedClientMetadata> {
  try {
    await dependencies.egress.check(clientId)
  } catch (error: unknown) {
    if (error instanceof BlockedEgressError) {
      throw metadataRefused(`${error.message} (${error.address})`)
    }

    // The guard resolves the host itself, and a name with no address fails here.
    if (error instanceof Error) {
      throw metadataRefused(`the host could not be checked: ${describeFailure(error)}`)
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
  } catch (error: unknown) {
    // A refused connection, a timeout, a failed TLS handshake and an address
    // the guard blocked at the socket all end here, each as an `Error`.
    if (error instanceof Error) {
      throw metadataRefused(`the request failed: ${describeFailure(error)}`)
    }

    throw error
  }

  // A redirect is an answer other than 200 too: `redirect: 'manual'` hands it
  // back here and nothing follows it.
  if (response.status !== 200) {
    await response.body?.cancel()
    throw metadataRefused(`the host answered ${String(response.status)}`)
  }

  let text: string

  try {
    text = await readCapped(response, METADATA_MAX_BYTES)
  } catch (error: unknown) {
    // The timeout covers the body too, and a host can drop the connection
    // part of the way through it.
    if (error instanceof Error && !(error instanceof OAuthClientError)) {
      throw metadataRefused(`the body could not be read: ${describeFailure(error)}`)
    }

    throw error
  }

  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw metadataRefused('the document is not JSON')
    }

    throw error
  }

  const parsed = metadataDocument.safeParse(raw)

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')

    throw metadataRefused(`the document is missing required fields or has fields of the wrong shape: ${fields}`)
  }

  const document = parsed.data

  // The document must claim the URL it was fetched from. Anything else would
  // let one site's document stand in for another client.
  if (document.client_id !== clientId) {
    throw metadataRefused('the document names a different client_id')
  }

  // A document cannot hold a shared secret, and Kelpie does not verify
  // private_key_jwt, so a metadata-document client is always public.
  if (document.token_endpoint_auth_method !== undefined && document.token_endpoint_auth_method !== 'none') {
    throw metadataRefused('the document asks for a token endpoint auth method other than none')
  }

  // The reasons name no value from the document: the log must not hold what
  // an internal host answered.
  if (document.redirect_uris.some((uri) => redirectUriProblem(uri) !== undefined)) {
    throw metadataRefused('the document lists a redirect URI that is not allowed')
  }

  return {
    clientName: document.client_name ?? new URL(clientId).hostname,
    clientUri: httpsOrNull(document.client_uri),
    logoUri: httpsOrNull(document.logo_uri),
    redirectUris: document.redirect_uris,
  }
}

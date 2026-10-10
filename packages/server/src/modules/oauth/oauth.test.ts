import { createHash } from 'node:crypto'

import { API_KEY_OBJECT_DATA_RESOURCES } from '@kelpie/schemas'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { users } from '../auth/schema.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import { WORKSPACE_ACCESS } from '../workspace/capabilities.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { CLIENT_METADATA_REFUSED } from './clients.ts'
import type { Fetch } from './clients.ts'
import { createOAuthModule } from './index.ts'
import { oauthClients, oauthConnections, oauthGrants, oauthRequests, oauthTokens } from './schema.ts'
import { UNUSED_METADATA_CLIENT_LIFETIME_MS } from './service.ts'

/**
 * The authorization server end to end, against real Postgres: discovery, a
 * client registering, the consent page's endpoints, the code exchange, refresh
 * rotation, and the token reaching `/mcp` and nothing else.
 */

const connectionString = testDatabaseUrl(process.env)

const RESOURCE = `${TEST_APP_BASE_URL}/mcp`
const REDIRECT = 'http://127.0.0.1:33418/callback'
/** A redirect on a public host: one program owns it, unlike a loopback port. */
const WEB_REDIRECT = 'https://client.example/callback'
/** Makes an authorize request come from the web redirect of a client that has both. */
const FROM_WEB = { redirect_uri: WEB_REDIRECT }
const VERIFIER = 'a-verifier-that-is-long-enough-to-satisfy-rfc-7636-rules'
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url')
const METADATA_CLIENT_ID = 'https://client.example/oauth/metadata.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string') {
    throw new Error(`Expected "${key}" on ${JSON.stringify(payload)}`)
  }

  return payload[key]
}

function readList(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`Expected a list envelope, got ${JSON.stringify(payload)}`)
  }

  return payload.data.filter(isRecord)
}

/** Serves one metadata document, and records what was asked for. */
function metadataFetch(document: () => unknown): { fetch: Fetch; calls: string[] } {
  const calls: string[] = []

  return {
    calls,
    fetch: (input) => {
      calls.push(input)

      return Promise.resolve(
        new Response(JSON.stringify(document()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
  }
}

describe.skipIf(connectionString === undefined)('oauth', () => {
  let database: TestDatabase
  let harness: TestApp
  let metadataDocument: unknown
  let metadata: ReturnType<typeof metadataFetch>
  /** What the metadata host does in place of serving `metadataDocument`, when a test sets it. */
  let metadataFailure: Fetch | undefined
  /** The workspace the `workspace.access` gate refuses, when a test sets one. */
  let blockedWorkspaceId: string | undefined

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    metadataDocument = {
      client_id: METADATA_CLIENT_ID,
      client_name: 'Example Agent',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    }
    metadata = metadataFetch(() => metadataDocument)
    metadataFailure = undefined
    blockedWorkspaceId = undefined

    const entitlements = createEntitlementRegistry()

    entitlements.provide((workspaceId, capability) =>
      Promise.resolve(
        capability.name === WORKSPACE_ACCESS.name && workspaceId === blockedWorkspaceId
          ? { kind: 'flag', granted: false }
          : undefined,
      ),
    )
    harness = await createTestApp({
      modules: coreModules.map((module) =>
        module.id === 'oauth'
          ? createOAuthModule(coreMigrationsDirectory, {
              fetch: (input, init) => (metadataFailure ?? metadata.fetch)(input, init),
            })
          : module,
      ),
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
      entitlements,
    })
  })

  function send(
    method: string,
    path: string,
    options: { body?: unknown; cookie?: string; bearer?: string } = {},
  ): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
          ...(options.bearer === undefined ? {} : { Authorization: `Bearer ${options.bearer}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    )
  }

  function sendForm(
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      }),
    )
  }

  function mcp(bearer: string | undefined, body: unknown): Promise<Response> {
    return Promise.resolve(
      harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function callTool(bearer: string, name: string, args: unknown = {}): Promise<Response> {
    return mcp(bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  }

  async function signUp(email: string): Promise<string> {
    const response = await send('POST', '/v1/auth/signup', {
      body: { email, name: 'Someone', password: 'correct horse battery staple' },
    })
    const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
    const payload: unknown = await response.json()

    if (!isRecord(payload) || !isRecord(payload.account) || typeof payload.account.id !== 'string') {
      throw new Error(`Expected a signed-up account, got ${JSON.stringify(payload)}`)
    }

    await database.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, payload.account.id))

    return cookie
  }

  async function owner(email = 'ada@example.com'): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await signUp(email)
    const created = await send('POST', '/v1/workspaces', {
      body: { name: 'Acme', timezone: 'Australia/Melbourne' },
      cookie,
    })

    return { cookie, workspaceId: readString(await created.json(), 'id') }
  }

  async function registerPublicClient(redirectUris: readonly string[] = [REDIRECT]): Promise<string> {
    const response = await send('POST', '/oauth/register', {
      body: { client_name: 'Test Agent', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' },
    })

    expect(response.status).toBe(201)

    return readString(await response.json(), 'client_id')
  }

  function authorizeUrl(clientId: string, overrides: Record<string, string | null> = {}): string {
    const params = new URLSearchParams()
    const values: Record<string, string | null> = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: RESOURCE,
      ...overrides,
    }

    for (const [name, value] of Object.entries(values)) {
      if (value !== null) {
        params.set(name, value)
      }
    }

    return `/oauth/authorize?${params.toString()}`
  }

  /** Runs authorize, and answers with the pending request id from the consent redirect. */
  async function startRequest(clientId: string, overrides: Record<string, string | null> = {}): Promise<string> {
    const response = await send('GET', authorizeUrl(clientId, overrides))

    expect(response.status).toBe(302)

    const location = response.headers.get('Location') ?? ''
    const match = /^\/consent\/(?<id>[^/?]+)$/u.exec(location)

    if (match?.groups?.id === undefined) {
      throw new Error(`Expected a consent redirect, got ${location}`)
    }

    return match.groups.id
  }

  async function approve(
    cookie: string,
    requestId: string,
    workspaces: string | readonly string[],
    scopes: readonly string[],
  ): Promise<URL> {
    const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
      body: { workspace_ids: typeof workspaces === 'string' ? [workspaces] : workspaces, scopes },
      cookie,
    })

    expect(response.status).toBe(200)

    return new URL(readString(await response.json(), 'redirect_url'))
  }

  async function exchange(clientId: string, code: string, verifier = VERIFIER): Promise<Response> {
    return sendForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    })
  }

  interface Tokens {
    readonly clientId: string
    readonly accessToken: string
    readonly refreshToken: string
    readonly cookie: string
    readonly workspaceId: string
  }

  /** A connected client, from registration to a token pair. */
  async function connect(
    scopes: readonly string[] = ['read:objects', 'write:objects'],
    requested = 'read:objects write:objects',
    redirectUris: readonly string[] = [REDIRECT],
  ): Promise<Tokens> {
    const { cookie, workspaceId } = await owner()
    const clientId = await registerPublicClient(redirectUris)
    const requestId = await startRequest(clientId, { scope: requested })
    const redirect = await approve(cookie, requestId, workspaceId, scopes)
    const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')

    expect(response.status).toBe(200)

    const body: unknown = await response.json()

    return {
      clientId,
      accessToken: readString(body, 'access_token'),
      refreshToken: readString(body, 'refresh_token'),
      cookie,
      workspaceId,
    }
  }

  describe('discovery', () => {
    it('serves protected resource metadata that names this deployment as its authorization server', async () => {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const response = await send('GET', path)
        const body: unknown = await response.json()

        expect(response.status).toBe(200)
        expect(body).toMatchObject({
          resource: RESOURCE,
          authorization_servers: [TEST_APP_BASE_URL],
          scopes_supported: ['read:objects', 'write:objects'],
        })
      }
    })

    it('serves authorization server metadata with PKCE, metadata documents and iss', async () => {
      const response = await send('GET', '/.well-known/oauth-authorization-server')
      const body: unknown = await response.json()

      expect(body).toMatchObject({
        issuer: TEST_APP_BASE_URL,
        authorization_endpoint: `${TEST_APP_BASE_URL}/oauth/authorize`,
        token_endpoint: `${TEST_APP_BASE_URL}/oauth/token`,
        registration_endpoint: `${TEST_APP_BASE_URL}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
    })

    it('tells a client with no token where to sign in', async () => {
      const response = await mcp(undefined, { jsonrpc: '2.0', id: 1, method: 'ping' })

      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="${TEST_APP_BASE_URL}/.well-known/oauth-protected-resource/mcp", scope="read:objects write:objects"`,
      )
    })

    it('marks a refused token as invalid_token', async () => {
      const response = await mcp('kp_oat_not-a-real-token', { jsonrpc: '2.0', id: 1, method: 'ping' })

      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toContain('error="invalid_token"')
    })
  })

  describe('the authorization code flow', () => {
    it('connects a registered public client and reaches MCP with the token', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)

      const pending = await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })
      const view: unknown = await pending.json()

      expect(pending.status).toBe(200)
      expect(view).toMatchObject({
        client_name: 'Test Agent',
        client_host: 'an app on this computer',
        scopes: ['read:objects', 'write:objects'],
        workspaces: [{ id: workspaceId, name: 'Acme', role: 'owner' }],
      })

      const redirect = await approve(cookie, requestId, workspaceId, ['read:objects', 'write:objects'])

      expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
      expect(redirect.searchParams.get('state')).toBe('xyz')
      expect(redirect.searchParams.get('iss')).toBe(TEST_APP_BASE_URL)

      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')
      const tokens: unknown = await response.json()

      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read:objects write:objects' })
      expect(readString(tokens, 'access_token')).toMatch(/^kp_oat_/u)
      expect(readString(tokens, 'refresh_token')).toMatch(/^kp_ort_/u)

      const listed = await callTool(readString(tokens, 'access_token'), 'people_list')
      const body: unknown = await listed.json()

      expect(listed.status).toBe(200)
      expect(isRecord(body) && isRecord(body.result) && body.result.isError).toBe(false)
    })

    it('refuses the token on the REST API', async () => {
      const { accessToken } = await connect()
      const response = await send('GET', '/v1/people', { bearer: accessToken })

      expect(response.status).toBe(401)
    })

    it('accepts a loopback redirect on another port, as native clients pick one at run time', async () => {
      const clientId = await registerPublicClient()

      await startRequest(clientId, { redirect_uri: 'http://127.0.0.1:50999/callback' })
    })

    it('does not redirect to a URI the client never registered', async () => {
      const clientId = await registerPublicClient()
      const response = await send('GET', authorizeUrl(clientId, { redirect_uri: 'https://attacker.example/cb' }))

      expect(response.status).toBe(400)
      expect(response.headers.get('Location')).toBeNull()
      expect(await response.text()).toContain('not valid')
    })

    /**
     * Anybody can register a client. A request that fails before a person has
     * agreed to anything must not send the browser on to that client's
     * redirect URI, or a link to this deployment would be a way to send
     * somebody anywhere.
     */
    describe('a request that fails before consent', () => {
      const ATTACKER = 'https://attacker.example/landing'

      it.each([
        { name: 'a response type other than code', overrides: { response_type: 'token' }, error: 'unsupported_response_type' },
        { name: 'no response type', overrides: { response_type: null }, error: 'unsupported_response_type' },
        { name: 'no PKCE challenge', overrides: { code_challenge: null }, error: 'invalid_request' },
        { name: 'a plain PKCE method', overrides: { code_challenge_method: 'plain' }, error: 'invalid_request' },
        { name: 'a resource other than /mcp', overrides: { resource: `${TEST_APP_BASE_URL}/v1` }, error: 'invalid_target' },
        { name: 'a scope that is not known', overrides: { scope: 'read:objects nonsense' }, error: 'invalid_scope' },
      ])('stops on a page of this deployment for $name', async ({ overrides, error }) => {
        const clientId = await registerPublicClient([ATTACKER])
        const response = await send('GET', authorizeUrl(clientId, { redirect_uri: ATTACKER, ...overrides }))
        const page = await response.text()

        expect(response.status).toBe(400)
        expect(response.headers.get('Location')).toBeNull()
        expect(response.headers.get('Content-Type')).toContain('text/html')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(page).toContain('This connection request is not valid')
        expect(page).toContain(`<code>${error}</code>`)
        expect(page).not.toContain('attacker.example')
        expect(await database.db.select().from(oauthRequests)).toHaveLength(0)
      })

      it('escapes what the page repeats from the request', async () => {
        const clientId = await registerPublicClient()
        const response = await send('GET', authorizeUrl(clientId, { scope: '<script>alert(1)</script>' }))
        const page = await response.text()

        expect(response.status).toBe(400)
        expect(page).not.toContain('<script>')
        expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      })

      it('changes nothing for a request that is valid', async () => {
        const { cookie, workspaceId } = await owner()
        const clientId = await registerPublicClient([WEB_REDIRECT])
        const requestId = await startRequest(clientId, { ...FROM_WEB, scope: 'read:objects' })
        const redirect = await approve(cookie, requestId, workspaceId, ['read:objects'])

        expect(`${redirect.origin}${redirect.pathname}`).toBe(WEB_REDIRECT)
        expect(redirect.searchParams.get('code')).toEqual(expect.any(String))
        expect(redirect.searchParams.get('state')).toBe('xyz')
        expect(redirect.searchParams.get('error')).toBeNull()
      })
    })

    it('reports access_denied when the user denies', async () => {
      const { cookie } = await owner()
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)
      const response = await send('POST', `/v1/oauth/requests/${requestId}/deny`, { cookie })
      const redirect = new URL(readString(await response.json(), 'redirect_url'))

      expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
      expect(redirect.searchParams.get('error')).toBe('access_denied')
      expect(redirect.searchParams.get('state')).toBe('xyz')
      expect(redirect.searchParams.get('iss')).toBe(TEST_APP_BASE_URL)
    })

    it('lets the user remove requested scopes but not add others', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId, { scope: 'read:objects' })
      const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
        body: { workspace_ids: [workspaceId], scopes: ['read:objects', 'admin'] },
        cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses a workspace the user does not belong to', async () => {
      const first = await owner()
      const second = await owner('bea@example.com')
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)
      const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
        body: { workspace_ids: [first.workspaceId, second.workspaceId], scopes: ['read:objects'] },
        cookie: first.cookie,
      })

      // All or nothing: the workspace the user does belong to is not granted either.
      expect(response.status).toBe(422)
      expect(await database.db.select().from(oauthGrants)).toHaveLength(0)
      expect(await database.db.select().from(oauthConnections)).toHaveLength(0)
    })

    it('refuses an approval that names no workspace', async () => {
      const { cookie } = await owner()
      const requestId = await startRequest(await registerPublicClient())
      const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
        body: { workspace_ids: [], scopes: ['read:objects'] },
        cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses an API key on the consent endpoints', async () => {
      const { cookie } = await owner()
      const minted = await send('POST', '/v1/api-keys', { body: { name: 'CI', kind: 'workspace' }, cookie })
      const key = readString(await minted.json(), 'secret')
      const response = await send('GET', '/v1/oauth/grants', { bearer: key })

      expect(response.status).toBe(403)
    })
  })

  describe('the token endpoint', () => {
    it('refuses a wrong PKCE verifier', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '', `${'b'.repeat(43)}`)

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
    })

    it('leaves the code good after a wrong PKCE verifier, so the client it was issued to can still use it', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''

      for (const verifier of ['b'.repeat(43), 'too-short', '']) {
        const refused = await exchange(clientId, code, verifier)

        expect(refused.status, verifier).toBe(400)
        expect(await refused.json(), verifier).toMatchObject({ error: 'invalid_grant' })
      }

      expect(await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'access'))).toHaveLength(0)

      const accepted = await exchange(clientId, code)

      expect(accepted.status).toBe(200)
      expect((await callTool(readString(await accepted.json(), 'access_token'), 'people_list')).status).toBe(200)
    })

    it('leaves the code good after a wrong redirect_uri or resource', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''
      const fields = { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: VERIFIER }
      const wrongRedirect = await sendForm('/oauth/token', { ...fields, redirect_uri: 'http://127.0.0.1:1/other' })

      expect(wrongRedirect.status).toBe(400)
      expect(await wrongRedirect.json()).toMatchObject({ error: 'invalid_grant' })
      expect((await exchange(clientId, code)).status).toBe(200)
    })

    it('does not let a wrong verifier revoke a connection after its code was used', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''
      const accessToken = readString(await (await exchange(clientId, code)).json(), 'access_token')

      // The code itself was presented again, so this is still a replay.
      expect((await exchange(clientId, code, 'b'.repeat(43))).status).toBe(400)
      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
    })

    it('issues tokens to one of two requests that present the same code together', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''
      const responses = await Promise.all([exchange(clientId, code), exchange(clientId, code), exchange(clientId, code)])

      expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400])

      const refused = await Promise.all(
        responses.filter((response) => response.status === 400).map((response) => response.json()),
      )

      expect(refused).toEqual([
        expect.objectContaining({ error: 'invalid_grant' }),
        expect.objectContaining({ error: 'invalid_grant' }),
      ])
      // A code presented twice was copied, so what it issued is revoked.
      expect(await database.db.select().from(oauthTokens)).toHaveLength(0)
      expect(await database.db.select().from(oauthConnections)).toHaveLength(0)
    })

    it('refuses an expired code and does not spend it', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])

      await database.db
        .update(oauthTokens)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(oauthTokens.kind, 'code'))

      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
      expect(await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'access'))).toHaveLength(0)
    })

    describe('a code that was approved and not yet used', () => {
      const WIDE = ['read:objects', 'write:objects']

      /** An approval with both scopes whose code nobody exchanged yet. */
      async function approveWide(): Promise<{ clientId: string; cookie: string; workspaceId: string; code: string }> {
        const { cookie, workspaceId } = await owner()
        const clientId = await registerPublicClient()
        const redirect = await approve(cookie, await startRequest(clientId), workspaceId, WIDE)

        return { clientId, cookie, workspaceId, code: redirect.searchParams.get('code') ?? '' }
      }

      async function expectDead(clientId: string, code: string): Promise<void> {
        const response = await exchange(clientId, code)

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
        expect(await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'access'))).toHaveLength(0)
      }

      it('ends when the person approves the same client again with fewer scopes', async () => {
        const { clientId, cookie, workspaceId, code } = await approveWide()
        const narrow = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])

        await expectDead(clientId, code)

        const response = await exchange(clientId, narrow.searchParams.get('code') ?? '')

        expect(await response.json()).toMatchObject({ scope: 'read:objects' })
      })

      it('ends when the person removes the workspace from Connected apps', async () => {
        const { clientId, cookie, code } = await approveWide()
        const [grant] = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

        expect((await send('DELETE', `/v1/oauth/grants/${String(grant?.id)}`, { cookie })).status).toBe(204)
        await expectDead(clientId, code)
      })

      it('ends when the person ends the connection', async () => {
        const { clientId, cookie, code } = await approveWide()
        const [grant] = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

        expect(
          (await send('DELETE', `/v1/oauth/connections/${String(grant?.connection_id)}`, { cookie })).status,
        ).toBe(204)
        await expectDead(clientId, code)
      })

      it('carries no scope that a grant of its connection lacks', async () => {
        const { clientId, cookie, code } = await approveWide()
        const second = await send('POST', '/v1/workspaces', {
          body: { name: 'Second', timezone: 'Australia/Melbourne' },
          cookie,
        })
        const secondId = readString(await second.json(), 'id')

        // Another approval, for another workspace, with fewer scopes. The
        // first connection keeps its workspace and its scopes, so its code
        // still gives what the person approved for it and no more.
        await approve(cookie, await startRequest(clientId), secondId, ['read:objects'])

        const response = await exchange(clientId, code)

        expect(await response.json()).toMatchObject({ scope: WIDE.join(' ') })

        const codes = await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'code'))
        const grants = await database.db.select().from(oauthGrants)

        for (const row of codes) {
          const under = grants.filter((grant) => grant.connectionId === row.connectionId)

          expect(under.length).toBeGreaterThan(0)

          for (const grant of under) {
            expect(grant.scopes).toEqual(row.scopes)
          }
        }
      })
    })

    /**
     * RFC 6749 §5.2: a client that tried HTTP Basic and failed gets `401
     * invalid_client` and a `WWW-Authenticate` header that names the scheme.
     * Credentials that cannot be read are a failed try, never a server error.
     */
    describe('malformed Basic credentials', () => {
      const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
      const malformed: readonly { name: string; header: string }[] = [
        { name: 'no credentials', header: 'Basic' },
        { name: 'only spaces after the scheme', header: 'Basic    ' },
        { name: 'characters that are not base64', header: 'Basic !!!not-base64!!!' },
        { name: 'base64url characters', header: `Basic ${base64('a:b?>>').replaceAll('+', '-').replaceAll('/', '_')}_-` },
        { name: 'two values', header: `Basic ${base64('client:secret')} ${base64('more')}` },
        { name: 'no colon', header: `Basic ${base64('client-and-secret')}` },
        { name: 'an empty client id', header: `Basic ${base64(':secret')}` },
        { name: 'only a colon', header: `Basic ${base64(':')}` },
        { name: 'a percent sign that starts no escape in the id', header: `Basic ${base64('client%:secret')}` },
        { name: 'a percent sign that starts no escape in the secret', header: `Basic ${base64('client:se%zzcret')}` },
        { name: 'an escape cut short', header: `Basic ${base64('client:secret%2')}` },
        { name: 'an escape that is not UTF-8', header: `Basic ${base64('client:%C3%28')}` },
        { name: 'bytes that are not UTF-8', header: `Basic ${Buffer.from([0x63, 0xff, 0xfe, 0x3a, 0x73]).toString('base64')}` },
        { name: 'the scheme in lower case with no colon', header: `basic ${base64('nocolon')}` },
      ]

      it.each(malformed)('answers 401 invalid_client at the token endpoint for $name', async ({ header }) => {
        const response = await sendForm(
          '/oauth/token',
          { grant_type: 'authorization_code', code: 'x', code_verifier: VERIFIER },
          { Authorization: header },
        )

        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: 'invalid_client' })
        expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="kelpie"')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
      })

      it.each(malformed)('answers 401 invalid_client at the revocation endpoint for $name', async ({ header }) => {
        const response = await sendForm('/oauth/revoke', { token: 'x' }, { Authorization: header })

        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: 'invalid_client' })
        expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="kelpie"')
      })

      it('names the scheme when well-formed Basic credentials are wrong', async () => {
        const response = await sendForm(
          '/oauth/token',
          { grant_type: 'authorization_code', code: 'x', code_verifier: VERIFIER },
          { Authorization: `Basic ${base64('no-such-client:secret')}` },
        )

        expect(response.status).toBe(401)
        expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="kelpie"')
      })

      it('still reads the form when the header is another scheme', async () => {
        const { clientId, refreshToken } = await connect()
        const response = await sendForm(
          '/oauth/token',
          { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
          { Authorization: 'Bearer something-else' },
        )

        expect(response.status).toBe(200)
      })
    })

    it('revokes the grant when a code is used twice', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''
      const first = await exchange(clientId, code)
      const accessToken = readString(await first.json(), 'access_token')
      const second = await exchange(clientId, code)

      expect(second.status).toBe(400)
      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
    })

    it('rotates refresh tokens, and treats reuse as theft', async () => {
      const { clientId, refreshToken } = await connect()
      const refreshed = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })
      const next: unknown = await refreshed.json()

      expect(refreshed.status).toBe(200)
      expect(readString(next, 'refresh_token')).not.toBe(refreshToken)

      const replayed = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })

      expect(replayed.status).toBe(400)
      expect((await callTool(readString(next, 'access_token'), 'people_list')).status).toBe(401)
    })

    describe('a refresh request that fails a check', () => {
      const refreshWith = (clientId: string, refreshToken: string, extra: Record<string, string>): Promise<Response> =>
        sendForm('/oauth/token', {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          ...extra,
        })

      it.each([
        { name: 'a scope the grant does not hold', extra: { scope: 'read:objects handbook:write' }, error: 'invalid_scope' },
        { name: 'a scope that is not known', extra: { scope: 'nonsense' }, error: 'invalid_scope' },
        { name: 'a resource other than /mcp', extra: { resource: `${TEST_APP_BASE_URL}/v1` }, error: 'invalid_target' },
      ])('leaves the refresh token good after $name', async ({ extra, error }) => {
        const { clientId, accessToken, refreshToken } = await connect()
        const refused = await refreshWith(clientId, refreshToken, extra)

        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error })

        const [stored] = await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'refresh'))

        expect(stored?.usedAt).toBeNull()

        const accepted = await refreshWith(clientId, refreshToken, {})
        const next: unknown = await accepted.json()

        expect(accepted.status).toBe(200)
        // The connection is still there: the old access token and the new one both work.
        expect((await callTool(accessToken, 'people_list')).status).toBe(200)
        expect((await callTool(readString(next, 'access_token'), 'people_list')).status).toBe(200)
      })

      it('refuses an expired refresh token and does not spend it', async () => {
        const { clientId, refreshToken } = await connect()

        await database.db
          .update(oauthTokens)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(oauthTokens.kind, 'refresh'))

        const refused = await refreshWith(clientId, refreshToken, {})
        const [stored] = await database.db.select().from(oauthTokens).where(eq(oauthTokens.kind, 'refresh'))

        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error: 'invalid_grant' })
        expect(stored?.usedAt).toBeNull()
        expect(await database.db.select().from(oauthConnections)).toHaveLength(1)
      })

      it('still ends the connection when a spent refresh token comes with a bad scope', async () => {
        const { clientId, refreshToken } = await connect()
        const next: unknown = await (await refreshWith(clientId, refreshToken, {})).json()
        const replayed = await refreshWith(clientId, refreshToken, { scope: 'nonsense' })

        // The token itself was presented again, so this is a replay whatever else the request says.
        expect(replayed.status).toBe(400)
        expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' })
        expect((await callTool(readString(next, 'access_token'), 'people_list')).status).toBe(401)
        expect(await database.db.select().from(oauthConnections)).toHaveLength(0)
      })

      it('issues tokens to one of the requests that present the same refresh token together', async () => {
        const { clientId, refreshToken } = await connect()
        const responses = await Promise.all([
          refreshWith(clientId, refreshToken, {}),
          refreshWith(clientId, refreshToken, {}),
          refreshWith(clientId, refreshToken, {}),
        ])

        expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400])

        const refused = await Promise.all(
          responses.filter((response) => response.status === 400).map((response) => response.json()),
        )

        expect(refused).toEqual([
          expect.objectContaining({ error: 'invalid_grant' }),
          expect.objectContaining({ error: 'invalid_grant' }),
        ])
        // A refresh token presented twice is held by two parties, so the connection ends.
        expect(await database.db.select().from(oauthTokens)).toHaveLength(0)
        expect(await database.db.select().from(oauthConnections)).toHaveLength(0)
        expect(await database.db.select().from(oauthGrants)).toHaveLength(0)
      })
    })

    it('narrows scope on refresh but never widens it', async () => {
      const { clientId, refreshToken } = await connect(['read:objects'])
      const widened = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        scope: 'read:objects write:objects',
      })

      expect(widened.status).toBe(400)
      expect(await widened.json()).toMatchObject({ error: 'invalid_scope' })
    })

    it('authenticates a confidential client with its secret', async () => {
      const { cookie, workspaceId } = await owner()
      const registered = await send('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT] } })
      const client: unknown = await registered.json()
      const clientId = readString(client, 'client_id')
      const secret = readString(client, 'client_secret')

      expect(client).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic' })

      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const code = redirect.searchParams.get('code') ?? ''
      const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER }
      const withoutSecret = await sendForm('/oauth/token', { ...fields, client_id: clientId })

      expect(withoutSecret.status).toBe(401)

      const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64')
      const withSecret = await sendForm('/oauth/token', fields, { Authorization: `Basic ${basic}` })

      expect(withSecret.status).toBe(200)
    })

    it('ends the connection when the client revokes its refresh token', async () => {
      const { clientId, accessToken, refreshToken } = await connect()
      const response = await sendForm('/oauth/revoke', { token: refreshToken, client_id: clientId })

      expect(response.status).toBe(200)
      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
    })
  })

  describe('scopes at /mcp', () => {
    it('answers insufficient_scope for a tool the grant does not cover', async () => {
      const { accessToken } = await connect(['read:objects'])
      const response = await callTool(accessToken, 'people_create', { name: 'Grace Hopper' })

      expect(response.status).toBe(403)
      expect(response.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"')
      // What the token holds, then what it lacks: a client that asks for
      // this list keeps what it had.
      expect(response.headers.get('WWW-Authenticate')).toContain('scope="read:objects people:write"')
    })

    it('allows a tool the grant does cover', async () => {
      const { accessToken } = await connect(['read:objects', 'write:objects'])
      const response = await callTool(accessToken, 'people_create', { name: 'Grace Hopper' })

      expect(response.status).toBe(200)
    })
  })

  describe('what an OAuth caller writes', () => {
    /** The JSON a tool call answered with. */
    async function toolPayload(response: Response): Promise<unknown> {
      const body: unknown = await response.json()

      if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.content)) {
        throw new Error(`Expected a tool result, got ${JSON.stringify(body)}`)
      }

      const [first]: unknown[] = body.result.content

      return JSON.parse(readString(first, 'text'))
    }

    it('records a note and a decision with origin agent, though a member approved the client', async () => {
      const { accessToken } = await connect()
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const target = { target_type: 'person', target_id: readString(person, 'id') }

      const note = await toolPayload(await callTool(accessToken, 'notes_create', { ...target, body: 'From OAuth' }))
      const decision = await toolPayload(
        await callTool(accessToken, 'decisions_create', { ...target, body: 'From OAuth' }),
      )

      expect(isRecord(note) && note.origin).toBe('agent')
      expect(isRecord(note) && note.author_id).toMatch(/^mem_/u)
      expect(isRecord(decision) && decision.origin).toBe('agent')
    })

    it('writes a decision as a proposal, and cannot rewrite a commitment, without decisions:commit', async () => {
      const { accessToken, cookie } = await connect()
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const target = { target_type: 'person', target_id: readString(person, 'id') }
      const proposed = await toolPayload(
        await callTool(accessToken, 'decisions_create', { ...target, body: 'From OAuth' }),
      )

      expect(proposed).toMatchObject({ origin: 'agent', confirmed_at: null, confirmed_by_id: null })

      // Its own proposal is its to change.
      const reworded = await toolPayload(
        await callTool(accessToken, 'decisions_update', { id: readString(proposed, 'id'), body: 'Reworded' }),
      )

      expect(reworded).toMatchObject({ body: 'Reworded', confirmed_at: null })

      const byMember: unknown = await (
        await send('POST', '/v1/decisions', { body: { ...target, body: 'From a member' }, cookie })
      ).json()
      const refusedCall = await callTool(accessToken, 'decisions_update', {
        id: readString(byMember, 'id'),
        body: 'Rewritten over OAuth',
      })
      const refused: unknown = await refusedCall.json()

      // A tool error and not a scope challenge: `decisions:write` is held, and
      // the answer must not send the client to ask for more access.
      expect(refusedCall.status).toBe(200)
      expect(isRecord(refused) && isRecord(refused.result) && refused.result.isError).toBe(true)
      expect(JSON.stringify(refused)).toContain('This decision is confirmed, and this connection cannot change its text')
      expect(await (await send('GET', `/v1/decisions/${readString(byMember, 'id')}`, { cookie })).json()).toEqual(
        byMember,
      )

      // A date is not the text, so that change is allowed and the decision stays confirmed.
      const dated = await toolPayload(
        await callTool(accessToken, 'decisions_update', {
          id: readString(byMember, 'id'),
          due_at: '2026-09-01T00:00:00.000Z',
        }),
      )

      expect(isRecord(dated) && dated.confirmed_at).toBe(isRecord(byMember) && byMember.confirmed_at)
      expect(dated).toMatchObject({ body: 'From a member', origin: 'member' })
    })

    it('writes a decision as a commitment when the person gave decisions:commit', async () => {
      const scopes = ['read:objects', 'write:objects', 'decisions:commit']
      const { accessToken, cookie } = await connect(scopes, scopes.join(' '))
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const target = { target_type: 'person', target_id: readString(person, 'id') }
      const decision = await toolPayload(
        await callTool(accessToken, 'decisions_create', { ...target, body: 'From OAuth' }),
      )

      expect(isRecord(decision) && decision.confirmed_at).toBe(isRecord(decision) && decision.decided_at)
      expect(isRecord(decision) && decision.confirmed_by_id).toBeNull()

      const byMember: unknown = await (
        await send('POST', '/v1/decisions', { body: { ...target, body: 'From a member' }, cookie })
      ).json()
      const rewritten = await toolPayload(
        await callTool(accessToken, 'decisions_update', { id: readString(byMember, 'id'), body: 'Rewritten over OAuth' }),
      )

      expect(isRecord(rewritten) && rewritten.confirmed_at).toBe(isRecord(byMember) && byMember.confirmed_at)
      expect(rewritten).toMatchObject({ origin: 'agent', confirmed_by_id: null })
    })

    it('refuses a tool call that sends origin', async () => {
      const { accessToken } = await connect()
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const response = await callTool(accessToken, 'notes_create', {
        target_type: 'person',
        target_id: readString(person, 'id'),
        body: 'From OAuth',
        origin: 'member',
      })
      const body: unknown = await response.json()

      expect(isRecord(body) && isRecord(body.result) && body.result.isError).toBe(true)
    })
  })

  describe('extra permissions at consent', () => {
    const DEFAULT = ['read:objects', 'write:objects']
    const WITH_COMMIT = [...DEFAULT, 'decisions:commit']

    /** The JSON a tool call answered with. */
    async function toolPayload(response: Response): Promise<unknown> {
      const body: unknown = await response.json()

      if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.content)) {
        throw new Error(`Expected a tool result, got ${JSON.stringify(body)}`)
      }

      const [first]: unknown[] = body.result.content

      return JSON.parse(readString(first, 'text'))
    }

    /** Whether a Decision this token writes is a commitment at once. */
    async function commits(accessToken: string, workspaceId?: string): Promise<boolean> {
      const workspace = workspaceId === undefined ? {} : { workspace_id: workspaceId }
      const person = await toolPayload(
        await callTool(accessToken, 'people_create', { ...workspace, name: 'Grace Hopper' }),
      )
      const decision = await toolPayload(
        await callTool(accessToken, 'decisions_create', {
          ...workspace,
          target_type: 'person',
          target_id: readString(person, 'id'),
          body: 'From OAuth',
        }),
      )

      return isRecord(decision) && decision.confirmed_at !== null
    }

    it('tells the consent page which extras the person may add', async () => {
      const { cookie } = await owner()
      const clientId = await registerPublicClient()
      const plain = await send('GET', `/v1/oauth/requests/${await startRequest(clientId)}`, { cookie })
      const named = await send(
        'GET',
        `/v1/oauth/requests/${await startRequest(clientId, { scope: WITH_COMMIT.join(' ') })}`,
        { cookie },
      )

      const extras = ['decisions:commit', 'handbook:write', 'delete:objects']

      expect(await plain.json()).toMatchObject({ scopes: DEFAULT, extra_scopes: extras })
      // Asked for by name, it is still offered as an extra, so the page starts it clear.
      expect(await named.json()).toMatchObject({ scopes: WITH_COMMIT, extra_scopes: extras })
    })

    /** The `extra_scopes` of a request for this `scope` parameter. */
    async function extrasFor(scope: string): Promise<unknown> {
      const { cookie } = await owner()
      const clientId = await registerPublicClient()
      const response = await send('GET', `/v1/oauth/requests/${await startRequest(clientId, { scope })}`, { cookie })
      const body: unknown = await response.json()

      return isRecord(body) ? body.extra_scopes : undefined
    }

    it('shows a requested scope apart when it gives a sensitive power, under any name', async () => {
      expect(await extrasFor('read:objects write:objects people:delete')).toEqual([
        'people:delete',
        'decisions:commit',
        'handbook:write',
        'delete:objects',
      ])
    })

    it('shows a requested preset apart, whole, when it holds a sensitive scope', async () => {
      // `write:all` holds `handbook:write`. `write:admin` and `admin` hold nothing sensitive.
      expect(await extrasFor('read:all write:all write:admin admin')).toEqual([
        'write:all',
        'decisions:commit',
        'handbook:write',
        'delete:objects',
      ])
    })

    it('still offers Delete objects when the client asks for every delete scope by name', async () => {
      const deletes = API_KEY_OBJECT_DATA_RESOURCES.map((resource) => `${resource}:delete`)

      expect(await extrasFor(['read:objects', ...deletes].join(' '))).toEqual([
        ...deletes,
        'decisions:commit',
        'handbook:write',
        'delete:objects',
      ])
    })

    it('says which sensitive scopes the client holds already, for each workspace, from the stored grant', async () => {
      const scopes = [...DEFAULT, 'handbook:write', 'people:delete']
      const { clientId, cookie, workspaceId } = await connect(scopes, scopes.join(' '), [REDIRECT, WEB_REDIRECT])
      const created = await send('POST', '/v1/workspaces', {
        body: { name: 'Globex', timezone: 'Australia/Melbourne' },
        cookie,
      })
      const otherWorkspaceId = readString(await created.json(), 'id')
      const requestId = await startRequest(clientId, {
        ...FROM_WEB,
        scope: 'read:objects write:objects people:delete deals:delete',
      })
      const body: unknown = await (await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })).json()
      const held = new Map(
        (isRecord(body) && Array.isArray(body.workspaces) ? body.workspaces : [])
          .filter(isRecord)
          .map((workspace) => [workspace.id, workspace.held_scopes]),
      )

      // The connected workspace holds two of the offered scopes. `deals:delete`
      // is asked for and not held. The other workspace has no grant.
      expect(held.get(workspaceId)).toEqual(['people:delete', 'handbook:write'])
      expect(held.get(otherWorkspaceId)).toEqual([])
      // Which workspaces the client has is said apart: a grant can hold no sensitive scope.
      expect(isRecord(body) && body.workspaces).toMatchObject([
        { id: workspaceId, connected: true },
        { id: otherWorkspaceId, connected: false },
      ])

      // Another client of the same person holds nothing.
      const otherClient = await registerPublicClient([WEB_REDIRECT])
      const fresh: unknown = await (
        await send('GET', `/v1/oauth/requests/${await startRequest(otherClient, FROM_WEB)}`, { cookie })
      ).json()

      expect(isRecord(fresh) && fresh.workspaces).toMatchObject([
        { connected: false, held_scopes: [] },
        { connected: false, held_scopes: [] },
      ])
    })

    it('marks a workspace as connected when its grant holds no sensitive scope, and for that person only', async () => {
      const { clientId, cookie, workspaceId } = await connect(DEFAULT, DEFAULT.join(' '), [REDIRECT, WEB_REDIRECT])
      const mine: unknown = await (
        await send('GET', `/v1/oauth/requests/${await startRequest(clientId, FROM_WEB)}`, { cookie })
      ).json()

      expect(isRecord(mine) && mine.workspaces).toMatchObject([{ id: workspaceId, connected: true, held_scopes: [] }])

      // Another person asks about the same client. They have their own workspace and no grant.
      const other = await owner('grace@example.com')
      const theirs: unknown = await (
        await send('GET', `/v1/oauth/requests/${await startRequest(clientId, FROM_WEB)}`, { cookie: other.cookie })
      ).json()

      expect(isRecord(theirs) && theirs.workspaces).toMatchObject([
        { id: other.workspaceId, connected: false, held_scopes: [] },
      ])
    })

    it('counts a scope as held when a wider scope of the grant gives it', async () => {
      const scopes = [...DEFAULT, 'delete:objects']
      const { clientId, cookie, workspaceId } = await connect(scopes, DEFAULT.join(' '), [REDIRECT, WEB_REDIRECT])
      const requestId = await startRequest(clientId, {
        ...FROM_WEB,
        scope: 'read:objects write:objects people:delete',
      })
      const body: unknown = await (await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })).json()

      expect(isRecord(body) && body.workspaces).toMatchObject([
        { id: workspaceId, held_scopes: ['people:delete', 'delete:objects'] },
      ])
    })

    /**
     * Any program on the person's computer can open a request with the
     * `client_id` of a native client and a loopback port of its own. So the
     * same grant is reported to a request from the web redirect and not to
     * one from a loopback redirect, on the registered port or on another.
     */
    it('reports nothing that ticks a box to a request that does not redirect to HTTPS, and still says what the client has', async () => {
      const scopes = [...DEFAULT, 'delete:objects']
      const custom = 'cursor://kelpie/callback'
      const { clientId, cookie, workspaceId } = await connect(scopes, DEFAULT.join(' '), [
        REDIRECT,
        WEB_REDIRECT,
        custom,
      ])
      const read = async (overrides: Record<string, string>): Promise<unknown> =>
        (await send('GET', `/v1/oauth/requests/${await startRequest(clientId, overrides)}`, { cookie })).json()
      const facts = { display_connected: true, display_held_scopes: ['delete:objects'] }

      // An HTTPS redirect belongs to one party: both pairs of fields say the same.
      expect(await read(FROM_WEB)).toMatchObject({
        local_client: false,
        workspaces: [{ id: workspaceId, connected: true, held_scopes: ['delete:objects'], ...facts }],
      })

      // A loopback redirect on the registered port and on another, and a
      // private-use scheme, which a second program can register too.
      for (const redirect of [REDIRECT, 'http://127.0.0.1:50999/callback', custom]) {
        const body = await read({ redirect_uri: redirect })

        expect(body, redirect).toMatchObject({
          local_client: true,
          workspaces: [{ id: workspaceId, connected: false, held_scopes: [], ...facts }],
        })
        // The scopes are still offered. They only start clear.
        expect(isRecord(body) && body.extra_scopes).toEqual(['decisions:commit', 'handbook:write', 'delete:objects'])
      }
    })

    it('shows what a client has only to the person whose grants they are, and only for that client', async () => {
      const scopes = [...DEFAULT, 'delete:objects']
      const { clientId, cookie } = await connect(scopes)
      const nothing = { connected: false, held_scopes: [], display_connected: false, display_held_scopes: [] }

      // Another person asks about the same client.
      const other = await owner('grace@example.com')
      const theirs: unknown = await (
        await send('GET', `/v1/oauth/requests/${await startRequest(clientId)}`, { cookie: other.cookie })
      ).json()

      expect(isRecord(theirs) && theirs.workspaces).toMatchObject([{ id: other.workspaceId, ...nothing }])

      // The same person asks about another client.
      const otherClient = await registerPublicClient()
      const fresh: unknown = await (
        await send('GET', `/v1/oauth/requests/${await startRequest(otherClient)}`, { cookie })
      ).json()

      expect(isRecord(fresh) && fresh.workspaces).toMatchObject([nothing])

      // A bearer credential cannot read a consent request at all.
      const minted = await send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace', full_access: true },
        cookie,
      })
      const refused = await send('GET', `/v1/oauth/requests/${await startRequest(clientId)}`, {
        bearer: readString(await minted.json(), 'secret'),
      })

      expect(refused.status).toBe(403)
    })

    it('still lets a person give a loopback client a sensitive scope again by ticking it', async () => {
      const scopes = [...DEFAULT, 'delete:objects']
      const { clientId, cookie, workspaceId } = await connect(scopes)
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, scopes)
      const tokens: unknown = await (await exchange(clientId, redirect.searchParams.get('code') ?? '')).json()

      expect(readString(tokens, 'scope')).toBe(scopes.join(' '))
    })

    it('lets a step-up add one scope and keep the rest of the connection', async () => {
      const { accessToken, clientId, cookie, workspaceId } = await connect()
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const refused = await callTool(accessToken, 'people_delete', { id: readString(person, 'id') })
      const challenge = /scope="(?<scope>[^"]+)"/u.exec(refused.headers.get('WWW-Authenticate') ?? '')?.groups?.scope

      expect(challenge).toBe('read:objects write:objects people:delete')

      // The client asks for what the challenge named, and the person allows all of it.
      const requestId = await startRequest(clientId, { scope: challenge ?? '' })
      const redirect = await approve(cookie, requestId, workspaceId, (challenge ?? '').split(' '))
      const tokens: unknown = await (await exchange(clientId, redirect.searchParams.get('code') ?? '')).json()
      const next = readString(tokens, 'access_token')

      expect(await toolPayload(await callTool(next, 'people_delete', { id: readString(person, 'id') }))).toEqual({
        id: readString(person, 'id'),
        deleted: true,
      })
      // It can still do what it could before the step-up.
      expect((await callTool(next, 'people_create', { name: 'Ada Lovelace' })).status).toBe(200)
      expect((await callTool(next, 'people_list')).status).toBe(200)
    })

    it('names the sensitive powers of a connection under any name that gives them', async () => {
      const named = [...DEFAULT, 'people:delete']
      const first = await connect(named, named.join(' '))
      const one = readList(await (await send('GET', '/v1/oauth/grants', { cookie: first.cookie })).json())

      expect(one[0]).toMatchObject({ extra_scopes: ['people:delete'] })

      const redirect = await approve(
        first.cookie,
        await startRequest(first.clientId, { scope: 'read:all write:all' }),
        first.workspaceId,
        ['read:all', 'write:all'],
      )

      expect(redirect.searchParams.get('code')).not.toBeNull()

      const wide = readList(await (await send('GET', '/v1/oauth/grants', { cookie: first.cookie })).json())

      expect(wide[0]).toMatchObject({ scopes: ['read:all', 'write:all'], extra_scopes: ['handbook:write'] })
    })

    it('gives a default connection no delete and no handbook write, and names the scope it lacks', async () => {
      const { accessToken } = await connect()
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))

      const deleted = await callTool(accessToken, 'people_delete', { id: readString(person, 'id') })
      const written = await callTool(accessToken, 'handbook_pages_create', { title: 'Pricing', body: 'Text' })

      expect(deleted.status).toBe(403)
      expect(deleted.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"')
      expect(deleted.headers.get('WWW-Authenticate')).toContain('scope="read:objects write:objects people:delete"')
      expect(written.status).toBe(403)
      expect(written.headers.get('WWW-Authenticate')).toContain('scope="read:objects write:objects handbook:write"')
      // Reading the handbook and the person is still part of the default.
      expect((await callTool(accessToken, 'handbook_pages_list')).status).toBe(200)
      expect((await callTool(accessToken, 'people_get', { id: readString(person, 'id') })).status).toBe(200)
    })

    it('lets a connection delete and write the handbook when the person added those extras', async () => {
      const scopes = [...DEFAULT, 'handbook:write', 'delete:objects']
      const { accessToken, cookie } = await connect(scopes)
      const person = await toolPayload(await callTool(accessToken, 'people_create', { name: 'Grace Hopper' }))
      const written = await toolPayload(
        await callTool(accessToken, 'handbook_pages_create', { title: 'Pricing', body: 'Text' }),
      )
      const deleted = await toolPayload(await callTool(accessToken, 'people_delete', { id: readString(person, 'id') }))
      const listed = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

      expect(isRecord(written) && written.title).toBe('Pricing')
      expect(deleted).toEqual({ id: readString(person, 'id'), deleted: true })
      expect(listed[0]).toMatchObject({ scopes, extra_scopes: ['handbook:write', 'delete:objects'] })
    })

    it('gives an extra the client did not request, in the token response, the grant and the token', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, WITH_COMMIT)
      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')
      const body: unknown = await response.json()

      expect(response.status).toBe(200)
      expect(readString(body, 'scope')).toBe(WITH_COMMIT.join(' '))

      const [grant] = await database.db.select().from(oauthGrants)
      const tokens = await database.db.select().from(oauthTokens)

      expect(grant?.scopes).toEqual(WITH_COMMIT)
      expect(tokens.map((token) => token.scopes)).toEqual([WITH_COMMIT, WITH_COMMIT, WITH_COMMIT])
      expect(await commits(readString(body, 'access_token'))).toBe(true)

      const listed = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

      expect(listed[0]).toMatchObject({ scopes: WITH_COMMIT, extra_scopes: ['decisions:commit'] })
    })

    it('gives no extra to an approval that does not name one', async () => {
      const { accessToken, cookie } = await connect()
      const listed = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

      expect(listed[0]).toMatchObject({ scopes: DEFAULT, extra_scopes: [] })
      expect(await commits(accessToken)).toBe(false)
    })

    it('still refuses an unrequested scope that is not an extra, and grants nothing', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()

      for (const scope of ['webhooks:write', 'admin', 'write:all', 'decisions:read']) {
        const response = await send('POST', `/v1/oauth/requests/${await startRequest(clientId)}/approve`, {
          body: { workspace_ids: [workspaceId], scopes: [...WITH_COMMIT, scope] },
          cookie,
        })

        expect(response.status).toBe(422)
      }

      expect(await database.db.select().from(oauthGrants)).toHaveLength(0)
      expect(await database.db.select().from(oauthTokens)).toHaveLength(0)
    })

    it('keeps the extra across a refresh, and narrows it away when the client asks', async () => {
      const scopes = WITH_COMMIT
      const { clientId, refreshToken } = await connect(scopes)
      const refreshed = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      })
      const next: unknown = await refreshed.json()

      expect(refreshed.status).toBe(200)
      expect(readString(next, 'scope')).toBe(scopes.join(' '))
      expect(await commits(readString(next, 'access_token'))).toBe(true)

      const narrowed = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: readString(next, 'refresh_token'),
        client_id: clientId,
        scope: DEFAULT.join(' '),
      })
      const narrow: unknown = await narrowed.json()

      expect(narrowed.status).toBe(200)
      expect(readString(narrow, 'scope')).toBe(DEFAULT.join(' '))
      expect(await commits(readString(narrow, 'access_token'))).toBe(false)
    })

    it('does not let a refresh add an extra that the person did not give', async () => {
      const { clientId, refreshToken } = await connect()
      const widened = await sendForm('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        scope: WITH_COMMIT.join(' '),
      })

      expect(widened.status).toBe(400)
      expect(readString(await widened.json(), 'error')).toBe('invalid_scope')
    })

    it('gives the extra in each workspace of a connection that covers more than one', async () => {
      const { cookie, workspaceId } = await owner()
      const created = await send('POST', '/v1/workspaces', {
        body: { name: 'Globex', timezone: 'Australia/Melbourne' },
        cookie,
      })
      const otherWorkspaceId = readString(await created.json(), 'id')
      const clientId = await registerPublicClient()
      const redirect = await approve(cookie, await startRequest(clientId), [workspaceId, otherWorkspaceId], WITH_COMMIT)
      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')
      const accessToken = readString(await response.json(), 'access_token')

      expect(await database.db.select().from(oauthConnections)).toHaveLength(1)
      expect((await database.db.select().from(oauthGrants)).map((grant) => grant.scopes)).toEqual([
        WITH_COMMIT,
        WITH_COMMIT,
      ])
      expect(await commits(accessToken, workspaceId)).toBe(true)
      expect(await commits(accessToken, otherWorkspaceId)).toBe(true)
    })
  })

  describe('connected apps', () => {
    it('lists the connection and revokes it', async () => {
      const { accessToken, cookie, workspaceId } = await connect()
      const listed = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())

      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({ client_name: 'Test Agent', workspace_id: workspaceId, workspace_name: 'Acme' })

      const revoked = await send('DELETE', `/v1/oauth/grants/${String(listed[0]?.id)}`, { cookie })

      expect(revoked.status).toBe(204)
      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
    })

    it('ends access when the user leaves the workspace', async () => {
      const { accessToken, workspaceId } = await connect()
      const [grant] = await database.db.select().from(oauthGrants)

      await database.db
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, grant?.userId ?? '')))

      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
    })

    it('revokes older tokens when the user approves the same client again', async () => {
      const { accessToken, clientId, cookie, workspaceId } = await connect()

      await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])

      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
      expect(await database.db.select().from(oauthGrants)).toHaveLength(1)
    })
  })

  describe('several workspaces in one connection', () => {
    interface TwoWorkspaces extends Tokens {
      readonly otherWorkspaceId: string
    }

    /** One user, owner of two workspaces, and one connection that covers both. */
    async function connectTwo(): Promise<TwoWorkspaces> {
      const { cookie, workspaceId } = await owner()
      const created = await send('POST', '/v1/workspaces', {
        body: { name: 'Globex', timezone: 'Australia/Melbourne' },
        cookie,
      })
      const otherWorkspaceId = readString(await created.json(), 'id')
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)
      const redirect = await approve(cookie, requestId, [workspaceId, otherWorkspaceId], [
        'read:objects',
        'write:objects',
      ])
      const response = await exchange(clientId, redirect.searchParams.get('code') ?? '')

      expect(response.status).toBe(200)

      const body: unknown = await response.json()

      return {
        clientId,
        accessToken: readString(body, 'access_token'),
        refreshToken: readString(body, 'refresh_token'),
        cookie,
        workspaceId,
        otherWorkspaceId,
      }
    }

    /** A tool call's result: whether the tool refused, and the JSON it answered. */
    async function toolResult(response: Response): Promise<{ isError: boolean; payload: unknown }> {
      const body: unknown = await response.json()

      if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.content)) {
        throw new Error(`Expected a tool result, got ${JSON.stringify(body)}`)
      }

      const [first]: unknown[] = body.result.content

      return { isError: body.result.isError === true, payload: JSON.parse(readString(first, 'text')) }
    }

    async function listedTools(bearer: string): Promise<Record<string, unknown>[]> {
      const response = await mcp(bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const body: unknown = await response.json()

      if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.tools)) {
        throw new Error(`Expected a tool listing, got ${JSON.stringify(body)}`)
      }

      return body.result.tools.filter(isRecord)
    }

    it('makes one connection with a grant for each workspace', async () => {
      const { workspaceId, otherWorkspaceId } = await connectTwo()
      const connections = await database.db.select().from(oauthConnections)
      const grants = await database.db.select().from(oauthGrants)

      expect(connections).toHaveLength(1)
      expect(grants.map((grant) => grant.workspaceId).sort()).toEqual([workspaceId, otherWorkspaceId].sort())
      expect(grants.every((grant) => grant.connectionId === connections[0]?.id)).toBe(true)
    })

    it('leaves a connection with one workspace as it was: no workspace argument, no workspaces_list', async () => {
      const { accessToken } = await connect()
      const tools = await listedTools(accessToken)
      const peopleList = tools.find((tool) => tool.name === 'people_list')

      expect(tools.some((tool) => tool.name === 'workspaces_list')).toBe(false)
      expect(JSON.stringify(peopleList?.inputSchema)).not.toContain('workspace_id')
    })

    it('adds a mandatory workspace_id to each tool, and workspaces_list', async () => {
      const { accessToken, workspaceId, otherWorkspaceId } = await connectTwo()
      const tools = await listedTools(accessToken)
      const others = tools.filter((tool) => tool.name !== 'workspaces_list')

      expect(tools.some((tool) => tool.name === 'workspaces_list')).toBe(true)
      expect(others.length).toBeGreaterThan(0)

      for (const tool of others) {
        const schema = tool.inputSchema

        expect(isRecord(schema) && Array.isArray(schema.required) && schema.required.includes('workspace_id')).toBe(true)
        expect(isRecord(schema) && isRecord(schema.properties) && 'workspace_id' in schema.properties).toBe(true)
      }

      const listed = await toolResult(await callTool(accessToken, 'workspaces_list'))

      expect(listed.isError).toBe(false)
      expect(listed.payload).toEqual({
        data: [
          { id: workspaceId, name: 'Acme', role: 'owner' },
          { id: otherWorkspaceId, name: 'Globex', role: 'owner' },
        ],
      })
    })

    it('tells the agent that the connection covers more than one workspace', async () => {
      const { accessToken } = await connectTwo()
      const response = await mcp(accessToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })
      const body: unknown = await response.json()

      expect(isRecord(body) && isRecord(body.result) && String(body.result.instructions)).toContain('workspaces_list')
    })

    it('refuses a call that names no workspace, and one for a workspace it does not cover', async () => {
      const { accessToken } = await connectTwo()
      const outsider = await owner('bea@example.com')

      const unnamed = await toolResult(await callTool(accessToken, 'people_list'))

      expect(unnamed.isError).toBe(true)
      expect(unnamed.payload).toMatchObject({ error: { code: 'validation_failed' } })

      const outside = await toolResult(
        await callTool(accessToken, 'people_list', { workspace_id: outsider.workspaceId }),
      )
      const missing = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: 'ws_nothing' }))

      expect(outside.isError).toBe(true)
      expect(outside.payload).toMatchObject({ error: { code: 'not_found' } })
      // The same answer for a workspace that exists and one that does not.
      expect(outside.payload).toEqual(missing.payload)
    })

    it('writes to the workspace the call names, and not to the other', async () => {
      const { accessToken, workspaceId, otherWorkspaceId } = await connectTwo()
      const created = await toolResult(
        await callTool(accessToken, 'people_create', { workspace_id: otherWorkspaceId, name: 'Grace Hopper' }),
      )

      expect(created.isError).toBe(false)

      const inOther = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId }))
      const inFirst = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: workspaceId }))

      expect(readList(inOther.payload).map((person) => person.name)).toEqual(['Grace Hopper'])
      expect(readList(inFirst.payload)).toHaveLength(0)
    })

    it('records the use on the grant of the named workspace only', async () => {
      const { accessToken, otherWorkspaceId } = await connectTwo()

      await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId })

      const grants = await database.db.select().from(oauthGrants)

      expect(grants.find((grant) => grant.workspaceId === otherWorkspaceId)?.lastUsedAt).not.toBeNull()
      expect(grants.find((grant) => grant.workspaceId !== otherWorkspaceId)?.lastUsedAt).toBeNull()
    })

    it('keeps the other workspace when the user disconnects one, and ends the token with the last', async () => {
      const { accessToken, cookie, workspaceId, otherWorkspaceId } = await connectTwo()
      const listed = readList(await (await send('GET', '/v1/oauth/grants', { cookie })).json())
      const first = listed.find((grant) => grant.workspace_id === workspaceId)
      const other = listed.find((grant) => grant.workspace_id === otherWorkspaceId)

      expect(listed).toHaveLength(2)
      expect(first?.connection_id).toBe(other?.connection_id)

      await send('DELETE', `/v1/oauth/grants/${String(first?.id)}`, { cookie })

      // A client that listed the tools before still sends the argument.
      const kept = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId }))
      const gone = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: workspaceId }))

      expect(kept.isError).toBe(false)
      expect(gone.payload).toMatchObject({ error: { code: 'not_found' } })

      await send('DELETE', `/v1/oauth/grants/${String(other?.id)}`, { cookie })

      expect((await callTool(accessToken, 'people_list')).status).toBe(401)
      expect(await database.db.select().from(oauthConnections)).toHaveLength(0)
      expect(await database.db.select().from(oauthTokens)).toHaveLength(0)
    })

    it('disconnects every workspace at once', async () => {
      const { accessToken, cookie } = await connectTwo()
      const [connection] = await database.db.select().from(oauthConnections)
      const stranger = await owner('bea@example.com')

      // Another user's connection answers 404, and stays.
      expect(
        (await send('DELETE', `/v1/oauth/connections/${String(connection?.id)}`, { cookie: stranger.cookie })).status,
      ).toBe(404)
      expect((await send('DELETE', `/v1/oauth/connections/${String(connection?.id)}`, { cookie })).status).toBe(204)
      expect((await callTool(accessToken, 'workspaces_list')).status).toBe(401)
      expect(await database.db.select().from(oauthGrants)).toHaveLength(0)
    })

    it('ends one workspace only when the user leaves it', async () => {
      const { accessToken, workspaceId, otherWorkspaceId } = await connectTwo()
      const [grant] = await database.db.select().from(oauthGrants)

      await database.db
        .delete(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, otherWorkspaceId), eq(workspaceMembers.userId, grant?.userId ?? '')))

      const left = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId }))
      const stayed = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: workspaceId }))
      const listed = await toolResult(await callTool(accessToken, 'workspaces_list'))

      expect(left.payload).toMatchObject({ error: { code: 'not_found' } })
      expect(stayed.isError).toBe(false)
      expect(readList(listed.payload).map((workspace) => workspace.id)).toEqual([workspaceId])
    })

    it('refuses a blocked workspace and leaves the other in operation', async () => {
      const { accessToken, workspaceId, otherWorkspaceId } = await connectTwo()

      blockedWorkspaceId = otherWorkspaceId

      const blocked = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId }))
      const open = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: workspaceId }))

      expect(blocked.isError).toBe(true)
      expect(blocked.payload).toMatchObject({ error: { code: 'entitlement_required' } })
      expect(open.isError).toBe(false)
    })

    it('ends every workspace when a refresh token is used twice', async () => {
      const { accessToken, clientId, refreshToken } = await connectTwo()
      const fields = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }

      expect((await sendForm('/oauth/token', fields)).status).toBe(200)
      expect((await sendForm('/oauth/token', fields)).status).toBe(400)
      expect((await callTool(accessToken, 'workspaces_list')).status).toBe(401)
      expect(await database.db.select().from(oauthGrants)).toHaveLength(0)
    })

    it('moves a workspace to the new connection when the user approves it again', async () => {
      const { accessToken, clientId, cookie, workspaceId, otherWorkspaceId } = await connectTwo()
      const redirect = await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
      const renewed = readString(
        await (await exchange(clientId, redirect.searchParams.get('code') ?? '')).json(),
        'access_token',
      )

      // The old token keeps the workspace that was not approved again, and loses the one that was.
      const kept = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: otherWorkspaceId }))
      const moved = await toolResult(await callTool(accessToken, 'people_list', { workspace_id: workspaceId }))

      expect(kept.isError).toBe(false)
      expect(moved.payload).toMatchObject({ error: { code: 'not_found' } })
      expect((await toolResult(await callTool(renewed, 'people_list'))).isError).toBe(false)
      expect(await database.db.select().from(oauthConnections)).toHaveLength(2)
      expect(await database.db.select().from(oauthGrants)).toHaveLength(2)
    })
  })

  describe('client registration', () => {
    describe('registered clients that are more than 30 days old', () => {
      const OLD = new Date(Date.now() - 31 * 24 * 60 * 60_000)

      /** Registers a client, and makes it look 31 days old. */
      async function registerOldClient(): Promise<string> {
        const clientId = await registerPublicClient()

        await database.db.update(oauthClients).set({ createdAt: OLD }).where(eq(oauthClients.clientId, clientId))

        return clientId
      }

      async function clientExists(clientId: string): Promise<boolean> {
        const rows = await database.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId))

        return rows.length > 0
      }

      it('removes one that nothing refers to, at the next registration', async () => {
        const clientId = await registerOldClient()

        await registerPublicClient()

        expect(await clientExists(clientId)).toBe(false)
      })

      it('keeps one with a pending request, and the person can still approve it', async () => {
        const { cookie, workspaceId } = await owner()
        const clientId = await registerOldClient()
        const requestId = await startRequest(clientId)

        await registerPublicClient()

        expect(await clientExists(clientId)).toBe(true)
        expect((await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })).status).toBe(200)

        const redirect = await approve(cookie, requestId, workspaceId, ['read:objects'])

        expect((await exchange(clientId, redirect.searchParams.get('code') ?? '')).status).toBe(200)
      })

      it('keeps one with a connection that lost its grants, until the connection is swept', async () => {
        const { cookie, workspaceId } = await owner()
        const clientId = await registerOldClient()

        await approve(cookie, await startRequest(clientId), workspaceId, ['read:objects'])
        // What a deleted workspace leaves behind through the cascade.
        await database.db.delete(oauthGrants)
        await registerPublicClient()

        expect(await clientExists(clientId)).toBe(true)
        expect(await database.db.select().from(oauthConnections)).toHaveLength(1)
      })

      it('keeps one with a grant', async () => {
        const { clientId, accessToken } = await connect()

        await database.db.update(oauthClients).set({ createdAt: OLD }).where(eq(oauthClients.clientId, clientId))
        await registerPublicClient()

        expect(await clientExists(clientId)).toBe(true)
        expect((await callTool(accessToken, 'people_list')).status).toBe(200)
      })
    })

    it('refuses a plain-HTTP redirect on a public host', async () => {
      const response = await send('POST', '/oauth/register', {
        body: { redirect_uris: ['http://client.example/callback'] },
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' })
    })

    it('uses a Client ID Metadata Document, and shows its host on the consent page', async () => {
      const { cookie } = await owner()
      const requestId = await startRequest(METADATA_CLIENT_ID, { redirect_uri: 'https://client.example/callback' })
      const view: unknown = await (await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })).json()

      expect(metadata.calls).toEqual([METADATA_CLIENT_ID])
      expect(view).toMatchObject({ client_name: 'Example Agent', client_host: 'client.example' })
    })

    it.each([
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'ftp://client.example/callback',
      'intent://callback',
      'myapp://callback',
    ])('refuses the redirect URI %s', async (uri) => {
      const response = await send('POST', '/oauth/register', { body: { redirect_uris: [REDIRECT, uri] } })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_redirect_uri' })
      expect(await database.db.select().from(oauthClients)).toHaveLength(0)
    })

    it('registers an app with a private-use scheme', async () => {
      await registerPublicClient(['cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth2redirect'])
    })

    describe('a redirect URI stored before the rule changed', () => {
      const OLD = 'ftp://client.example/callback'

      async function storeOldClient(): Promise<void> {
        await database.db.insert(oauthClients).values({
          id: 'oac_old',
          clientId: 'client-old',
          kind: 'registered',
          clientName: 'Old client',
          redirectUris: [OLD],
        })
      }

      it('is not redirected to from an authorize request', async () => {
        await storeOldClient()

        const response = await send('GET', authorizeUrl('client-old', { redirect_uri: OLD }))

        expect(response.status).toBe(400)
        expect(response.headers.get('Location')).toBeNull()
        expect(await database.db.select().from(oauthRequests)).toHaveLength(0)
      })

      it('is not redirected to from a request that was pending', async () => {
        const { cookie, workspaceId } = await owner()

        await storeOldClient()
        await database.db.insert(oauthRequests).values({
          id: 'orq_old',
          clientRowId: 'oac_old',
          redirectUri: OLD,
          codeChallenge: CHALLENGE,
          scopes: ['read:objects'],
          resource: RESOURCE,
          expiresAt: new Date(Date.now() + 60_000),
        })

        const approved = await send('POST', '/v1/oauth/requests/orq_old/approve', {
          body: { workspace_ids: [workspaceId], scopes: ['read:objects'] },
          cookie,
        })

        expect((await send('GET', '/v1/oauth/requests/orq_old', { cookie })).status).toBe(404)
        expect(approved.status).toBe(404)
        expect((await send('POST', '/v1/oauth/requests/orq_old/deny', { cookie })).status).toBe(404)
        expect(await database.db.select().from(oauthTokens)).toHaveLength(0)
      })
    })

    describe('a metadata document that cannot be used', () => {
      const SECRET = 'internal-admin-token-41c9'
      const respond =
        (status: number, body: string): Fetch =>
        () =>
          Promise.resolve(new Response(body, { status }))

      it('tells the caller the same thing whatever the host did, and logs the reason without the body', async () => {
        const failures: readonly { reason: string; fetch: Fetch }[] = [
          { reason: 'the request failed: TypeError: fetch failed', fetch: () => Promise.reject(new TypeError('fetch failed')) },
          { reason: 'the host answered 404', fetch: respond(404, SECRET) },
          { reason: 'the host answered 302', fetch: respond(302, SECRET) },
          { reason: 'the document is not JSON', fetch: respond(200, `<html>${SECRET}</html>`) },
          {
            reason: 'the document is missing required fields or has fields of the wrong shape: client_id, redirect_uris',
            fetch: respond(200, JSON.stringify({ secret: SECRET })),
          },
          {
            reason: 'the document names a different client_id',
            fetch: respond(200, JSON.stringify({ client_id: `https://other.example/${SECRET}`, redirect_uris: [WEB_REDIRECT] })),
          },
        ]
        const pages: string[] = []

        for (const failure of failures) {
          metadataFailure = failure.fetch

          const response = await send('GET', authorizeUrl(METADATA_CLIENT_ID, FROM_WEB))

          expect(response.status, failure.reason).toBe(400)
          expect(response.headers.get('Location'), failure.reason).toBeNull()
          pages.push(await response.text())

          const line = harness.logLines.findLast((logged) => logged.includes('metadata document refused')) ?? ''

          expect(line).toContain('"level":"warn"')
          expect(line).toContain(failure.reason)
          expect(line).toContain(METADATA_CLIENT_ID)
        }

        expect(new Set(pages).size).toBe(1)
        expect(pages[0]).toContain(CLIENT_METADATA_REFUSED)
        expect(pages[0]).not.toContain(SECRET)
        expect(harness.logLines.join('\n')).not.toContain(SECRET)
        expect(await database.db.select().from(oauthClients)).toHaveLength(0)
      })
    })

    describe('cached metadata-document clients', () => {
      const OTHER_CLIENT_ID = 'https://client.example/oauth/other.json'
      const LONG_AGO = new Date(Date.now() - UNUSED_METADATA_CLIENT_LIFETIME_MS - 60_000)

      /** Makes every cached client look as if no authorize request named it for more than the lifetime. */
      async function ageClients(): Promise<void> {
        await database.db.update(oauthClients).set({ updatedAt: LONG_AGO })
      }

      /** An authorize request for a second document, which is what runs the prune. */
      async function authorizeOther(): Promise<void> {
        metadataDocument = { ...(metadataDocument as Record<string, unknown>), client_id: OTHER_CLIENT_ID }
        await startRequest(OTHER_CLIENT_ID, FROM_WEB)
      }

      async function cachedClientIds(): Promise<string[]> {
        const rows = await database.db.select().from(oauthClients)

        return rows.map((row) => row.clientId).sort()
      }

      it('removes one that nothing refers to, when it was not named for an hour', async () => {
        await startRequest(METADATA_CLIENT_ID, FROM_WEB)
        await database.db.delete(oauthRequests)
        await ageClients()
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID])
      })

      it('removes one whose only request has expired', async () => {
        await startRequest(METADATA_CLIENT_ID, FROM_WEB)
        await database.db.update(oauthRequests).set({ expiresAt: new Date(Date.now() - 1_000) })
        await ageClients()
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID])
      })

      it('keeps one that was named a short time ago', async () => {
        await startRequest(METADATA_CLIENT_ID, FROM_WEB)
        await database.db.delete(oauthRequests)
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID, METADATA_CLIENT_ID].sort())
      })

      it('keeps one with a pending request', async () => {
        const { cookie } = await owner()
        const requestId = await startRequest(METADATA_CLIENT_ID, FROM_WEB)

        await ageClients()
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID, METADATA_CLIENT_ID].sort())
        expect((await send('GET', `/v1/oauth/requests/${requestId}`, { cookie })).status).toBe(200)
      })

      it('keeps one with a connection, and its code and tokens with it', async () => {
        const { cookie, workspaceId } = await owner()
        const first = await approve(cookie, await startRequest(METADATA_CLIENT_ID, FROM_WEB), workspaceId, ['read:objects'])
        const exchangeFromWeb = (code: string): Promise<Response> =>
          sendForm('/oauth/token', {
            grant_type: 'authorization_code',
            code,
            redirect_uri: WEB_REDIRECT,
            client_id: METADATA_CLIENT_ID,
            code_verifier: VERIFIER,
          })

        await ageClients()
        await authorizeOther()

        // The code was not exchanged yet when the prune ran.
        const tokens: unknown = await (await exchangeFromWeb(first.searchParams.get('code') ?? '')).json()

        await ageClients()
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID, METADATA_CLIENT_ID].sort())
        expect((await callTool(readString(tokens, 'access_token'), 'people_list')).status).toBe(200)
      })

      it('never removes a registered client on this path', async () => {
        const clientId = await registerPublicClient()

        await ageClients()
        await authorizeOther()

        expect(await cachedClientIds()).toEqual([OTHER_CLIENT_ID, clientId].sort())
      })

      it('keeps the cached row for the request that names it, without a second fetch', async () => {
        await startRequest(METADATA_CLIENT_ID, FROM_WEB)
        await database.db.delete(oauthRequests)
        await ageClients()

        // The request that names the client again must not lose it to its own prune.
        const requestId = await startRequest(METADATA_CLIENT_ID, FROM_WEB)
        const [row] = await database.db.select().from(oauthClients)

        expect(metadata.calls).toEqual([METADATA_CLIENT_ID])
        expect(await database.db.select().from(oauthRequests)).toMatchObject([{ id: requestId, clientRowId: row?.id }])
        expect(row?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime())
      })

      it('writes no row for a document that fails', async () => {
        metadataFailure = () => Promise.resolve(new Response('nothing here', { status: 404 }))

        await send('GET', authorizeUrl(METADATA_CLIENT_ID, FROM_WEB))

        expect(await database.db.select().from(oauthClients)).toHaveLength(0)
      })
    })

    it('refuses a metadata document that names a different client', async () => {
      metadataDocument = { ...(metadataDocument as Record<string, unknown>), client_id: 'https://other.example/x' }

      const response = await send(
        'GET',
        authorizeUrl(METADATA_CLIENT_ID, { redirect_uri: 'https://client.example/callback' }),
      )

      expect(response.status).toBe(400)
      expect(response.headers.get('Location')).toBeNull()
    })
  })
})

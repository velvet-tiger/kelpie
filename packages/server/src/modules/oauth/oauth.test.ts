import { createHash } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { users } from '../auth/schema.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import type { Fetch } from './clients.ts'
import { createOAuthModule } from './index.ts'
import { oauthGrants } from './schema.ts'

/**
 * The authorization server end to end, against real Postgres: discovery, a
 * client registering, the consent page's endpoints, the code exchange, refresh
 * rotation, and the token reaching `/mcp` and nothing else.
 */

const connectionString = testDatabaseUrl(process.env)

const RESOURCE = `${TEST_APP_BASE_URL}/mcp`
const REDIRECT = 'http://127.0.0.1:33418/callback'
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
    harness = await createTestApp({
      modules: coreModules.map((module) =>
        module.id === 'oauth' ? createOAuthModule(coreMigrationsDirectory, { fetch: metadata.fetch }) : module,
      ),
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
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

  async function owner(email = 'ada@example.com', slug = 'acme'): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await signUp(email)
    const created = await send('POST', '/v1/workspaces', {
      body: { name: 'Acme', slug, timezone: 'Australia/Melbourne' },
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

  async function approve(cookie: string, requestId: string, workspaceId: string, scopes: readonly string[]): Promise<URL> {
    const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
      body: { workspace_id: workspaceId, scopes },
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
  async function connect(scopes: readonly string[] = ['read:objects', 'write:objects']): Promise<Tokens> {
    const { cookie, workspaceId } = await owner()
    const clientId = await registerPublicClient()
    const requestId = await startRequest(clientId, { scope: 'read:objects write:objects' })
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

    it('sends an error back to the client for a resource other than /mcp', async () => {
      const clientId = await registerPublicClient()
      const response = await send('GET', authorizeUrl(clientId, { resource: `${TEST_APP_BASE_URL}/v1` }))
      const location = new URL(response.headers.get('Location') ?? '')

      expect(response.status).toBe(302)
      expect(location.searchParams.get('error')).toBe('invalid_target')
      expect(location.searchParams.get('iss')).toBe(TEST_APP_BASE_URL)
    })

    it('requires PKCE', async () => {
      const clientId = await registerPublicClient()
      const response = await send('GET', authorizeUrl(clientId, { code_challenge: null }))
      const location = new URL(response.headers.get('Location') ?? '')

      expect(location.searchParams.get('error')).toBe('invalid_request')
    })

    it('reports access_denied when the user denies', async () => {
      const { cookie } = await owner()
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)
      const response = await send('POST', `/v1/oauth/requests/${requestId}/deny`, { cookie })
      const redirect = new URL(readString(await response.json(), 'redirect_url'))

      expect(redirect.searchParams.get('error')).toBe('access_denied')
      expect(redirect.searchParams.get('state')).toBe('xyz')
    })

    it('lets the user remove requested scopes but not add others', async () => {
      const { cookie, workspaceId } = await owner()
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId, { scope: 'read:objects' })
      const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
        body: { workspace_id: workspaceId, scopes: ['read:objects', 'admin'] },
        cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses a workspace the user does not belong to', async () => {
      const first = await owner()
      const second = await owner('bea@example.com', 'other')
      const clientId = await registerPublicClient()
      const requestId = await startRequest(clientId)
      const response = await send('POST', `/v1/oauth/requests/${requestId}/approve`, {
        body: { workspace_id: second.workspaceId, scopes: ['read:objects'] },
        cookie: first.cookie,
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
      expect(response.headers.get('WWW-Authenticate')).toContain('scope="people:write"')
    })

    it('allows a tool the grant does cover', async () => {
      const { accessToken } = await connect(['read:objects', 'write:objects'])
      const response = await callTool(accessToken, 'people_create', { name: 'Grace Hopper' })

      expect(response.status).toBe(200)
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

  describe('client registration', () => {
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

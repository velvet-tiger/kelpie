import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

import type { RateLimitConfig } from '../../lib/rateLimit.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

/**
 * Rate limiting and security headers on `/v1`, against real Postgres.
 *
 * Each case tightens only the one budget it is testing and leaves the other
 * two generous, so a test can never fail because of a budget it did not mean
 * to exercise.
 */

const connectionString = testDatabaseUrl(process.env)

const GENEROUS = { limit: 1000, windowMs: 60_000 }

function rateLimitConfig(overrides: Partial<RateLimitConfig>): RateLimitConfig {
  return { forms: GENEROUS, auth: GENEROUS, api: GENEROUS, ...overrides }
}

const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
]

describe.skipIf(connectionString === undefined)('rate limiting and security headers', () => {
  let database: TestDatabase

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
  })

  /** Builds a harness with the given budgets and a `now()` the test can move forward. */
  async function harnessWithBudgets(
    rateLimit: RateLimitConfig,
    now: () => Date = () => new Date(),
  ): Promise<TestApp> {
    return createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db, now }),
      rateLimit,
    })
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function fieldIds(form: Record<string, unknown>): Record<string, string> {
    const fields = Array.isArray(form.fields) ? form.fields : []

    return Object.fromEntries(
      fields.filter(isRecord).map((field) => [String(field.label), String(field.id)]),
    )
  }

  async function createForm(client: TestClient, owner: TestOwner): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/forms', {
      body: { name: 'Website contact', fields: CONTACT_FIELDS },
      cookie: owner.cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  /**
   * `TestClient.send` carries only `Cookie` and `Authorization`; these cases
   * need `X-Forwarded-For` to simulate distinct callers, so they go through
   * `app.request` directly rather than the shared client.
   */
  function sendFrom(
    app: TestApp['app'],
    method: string,
    path: string,
    ip: string,
    body?: unknown,
  ): Promise<Response> {
    return Promise.resolve(
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  function submit(
    app: TestApp['app'],
    publicKey: string,
    ids: Record<string, string>,
    ip: string,
  ): Promise<Response> {
    return sendFrom(app, 'POST', `/v1/public/forms/${publicKey}/submit`, ip, {
      answers: { [ids.Name ?? '']: 'Alex Rivera', [ids.Email ?? '']: 'alex@example.com' },
    })
  }

  async function mintApiKey(client: TestClient, cookie: string): Promise<string> {
    const response = await client.send('POST', '/v1/api-keys', {
      body: { name: 'CI', kind: 'workspace' },
      cookie,
    })

    expect(response.status).toBe(201)

    return readString(await response.json(), 'secret')
  }

  describe('the forms budget', () => {
    it('answers 429 with Retry-After once one IP exceeds it, and lets another IP through', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ forms: { limit: 2, windowMs: 60_000 } }))
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const form = await createForm(client, owner)
      const ids = fieldIds(form)
      const publicKey = readString(form, 'public_key')

      expect((await submit(harness.app, publicKey, ids, '203.0.113.10')).status).toBe(201)
      expect((await submit(harness.app, publicKey, ids, '203.0.113.10')).status).toBe(201)

      const blocked = await submit(harness.app, publicKey, ids, '203.0.113.10')
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
      expect(readRecord(await blocked.json()).error).toMatchObject({ code: 'rate_limited' })

      const otherCaller = await submit(harness.app, publicKey, ids, '203.0.113.20')
      expect(otherCaller.status).toBe(201)
    })

    it('resets once the window has elapsed', async () => {
      let now = new Date('2026-01-01T00:00:00Z')
      const harness = await harnessWithBudgets(
        rateLimitConfig({ forms: { limit: 1, windowMs: 1000 } }),
        () => now,
      )
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const form = await createForm(client, owner)
      const ids = fieldIds(form)
      const publicKey = readString(form, 'public_key')

      expect((await submit(harness.app, publicKey, ids, '203.0.113.30')).status).toBe(201)
      expect((await submit(harness.app, publicKey, ids, '203.0.113.30')).status).toBe(429)

      now = new Date(now.getTime() + 1001)

      expect((await submit(harness.app, publicKey, ids, '203.0.113.30')).status).toBe(201)
    })

    it('does not limit the embed page, only the submit route', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ forms: { limit: 1, windowMs: 60_000 } }))
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const form = await createForm(client, owner)
      const publicKey = readString(form, 'public_key')

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await sendFrom(
          harness.app,
          'GET',
          `/v1/public/forms/${publicKey}/embed`,
          '203.0.113.40',
        )

        expect(response.status).toBe(200)
      }
    })
  })

  describe('the auth budget', () => {
    function login(app: TestApp['app'], ip: string): Promise<Response> {
      return sendFrom(app, 'POST', '/v1/auth/login', ip, {
        email: 'nobody@example.com',
        password: 'wrong',
      })
    }

    it('answers 429 with Retry-After once one IP exceeds it, and lets another IP through', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ auth: { limit: 2, windowMs: 60_000 } }))

      expect((await login(harness.app, '203.0.113.50')).status).toBe(401)
      expect((await login(harness.app, '203.0.113.50')).status).toBe(401)

      const blocked = await login(harness.app, '203.0.113.50')
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)

      expect((await login(harness.app, '203.0.113.60')).status).toBe(401)
    })

    it('shares its budget across every unauthenticated auth endpoint', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ auth: { limit: 1, windowMs: 60_000 } }))

      expect((await login(harness.app, '203.0.113.70')).status).toBe(401)

      const signup = await sendFrom(harness.app, 'POST', '/v1/auth/signup', '203.0.113.70', {
        email: 'fresh@example.com',
        name: 'Fresh',
        password: 'correct horse battery staple',
      })

      expect(signup.status).toBe(429)
    })
  })

  describe('the api budget', () => {
    it('answers 429 for an API key over budget but never limits a session', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ api: { limit: 2, windowMs: 60_000 } }))
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const secret = await mintApiKey(client, owner.cookie)

      const getWorkspace = (): Promise<Response> =>
        client.send('GET', `/v1/workspaces/${owner.workspaceId}`, { bearer: secret })

      expect((await getWorkspace()).status).toBe(200)
      expect((await getWorkspace()).status).toBe(200)

      const blocked = await getWorkspace()
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const sessionResponse = await client.send('GET', `/v1/workspaces/${owner.workspaceId}`, {
          cookie: owner.cookie,
        })

        expect(sessionResponse.status).toBe(200)
      }
    })

    it('is shared with the MCP transport, since every call there already carries an API key', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({ api: { limit: 2, windowMs: 60_000 } }))
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const secret = await mintApiKey(client, owner.cookie)

      const initialize = (): Promise<Response> =>
        Promise.resolve(
          harness.app.request('/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              Authorization: `Bearer ${secret}`,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {} },
            }),
          }),
        )

      expect((await initialize()).status).toBe(200)
      expect((await initialize()).status).toBe(200)

      const blocked = await initialize()
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    })
  })

  describe('security headers', () => {
    it('sends the hardening headers, plus X-Frame-Options, on an ordinary route', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({}))
      const response = await harness.app.request('/healthz')

      expect(response.headers.get('X-Frame-Options')).toBe('DENY')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Referrer-Policy')).not.toBeNull()
      expect(response.headers.get('Strict-Transport-Security')).not.toBeNull()
    })

    it('omits X-Frame-Options on the embed page, which sets its own CSP instead', async () => {
      const harness = await harnessWithBudgets(rateLimitConfig({}))
      const client = createTestClient(harness.app)
      const owner = await client.owner()
      const form = await createForm(client, owner)
      const publicKey = readString(form, 'public_key')

      const response = await harness.app.request(`/v1/public/forms/${publicKey}/embed`)

      expect(response.headers.get('X-Frame-Options')).toBeNull()
      expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors *')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })
  })
})

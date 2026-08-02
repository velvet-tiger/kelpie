import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { hashToken } from '../../lib/tokens.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import { apiKeys } from './schema.ts'

/** API keys and the bearer half of the auth middleware, against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

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

describe.skipIf(connectionString === undefined)('api keys', () => {
  let database: TestDatabase
  let harness: TestApp

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
    harness = await createTestApp({
      modules: coreModules,
      environment: { NODE_ENV: 'test' },
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

  async function signUp(email: string): Promise<string> {
    const response = await send('POST', '/v1/auth/signup', {
      body: { email, name: 'Someone', password: 'correct horse battery staple' },
    })

    return (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
  }

  /** A signed-in owner of a fresh workspace. */
  async function owner(email = 'ada@example.com', slug = 'acme'): Promise<{ cookie: string; workspaceId: string }> {
    const cookie = await signUp(email)
    const created = await send('POST', '/v1/workspaces', {
      body: { name: 'Acme', slug, timezone: 'Australia/Melbourne' },
      cookie,
    })

    return { cookie, workspaceId: readString(await created.json(), 'id') }
  }

  async function mint(cookie: string, kind: string, name = 'CI'): Promise<string> {
    const response = await send('POST', '/v1/api-keys', { body: { name, kind }, cookie })
    expect(response.status).toBe(201)

    return readString(await response.json(), 'secret')
  }

  describe('creating a key', () => {
    it('returns the secret once, with the documented prefix', async () => {
      const { cookie } = await owner()

      const response = await send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace' },
        cookie,
      })
      const body = await response.json()

      expect(response.status).toBe(201)
      expect(readString(body, 'secret')).toMatch(/^kp_live_/u)
      expect(readString(body, 'display_prefix')).toMatch(/^kp_live_…/u)
      expect(readString(body, 'kind')).toBe('workspace')
    })

    it('uses the personal prefix for a personal key', async () => {
      const { cookie } = await owner()

      expect(await mint(cookie, 'personal')).toMatch(/^kp_user_/u)
    })

    it('stores only a hash, never the secret', async () => {
      const { cookie } = await owner()
      const secret = await mint(cookie, 'workspace')

      const [stored] = await database.db.select().from(apiKeys)

      expect(stored?.secretHash).toBe(hashToken(secret))
      expect(JSON.stringify(stored)).not.toContain(secret)
    })

    it('never returns the secret again', async () => {
      const { cookie } = await owner()
      await mint(cookie, 'workspace')

      const listed = readList(await (await send('GET', '/v1/api-keys?kind=workspace', { cookie })).json())

      expect(listed).toHaveLength(1)
      expect(listed[0]).not.toHaveProperty('secret')
    })

    it('refuses before the account has a workspace', async () => {
      const cookie = await signUp('nobody@example.com')

      const response = await send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace' },
        cookie,
      })

      expect(response.status).toBe(403)
    })
  })

  describe('using a key', () => {
    it('reaches /v1 with a fresh workspace key', async () => {
      const { cookie, workspaceId } = await owner()
      const secret = await mint(cookie, 'workspace')

      const response = await send('GET', `/v1/workspaces/${workspaceId}`, { bearer: secret })

      expect(response.status).toBe(200)
      expect(readString(await response.json(), 'slug')).toBe('acme')
    })

    it('answers 401 after the key is revoked', async () => {
      const { cookie, workspaceId } = await owner()
      const secret = await mint(cookie, 'workspace')
      const listed = readList(await (await send('GET', '/v1/api-keys?kind=workspace', { cookie })).json())

      const revoked = await send('DELETE', `/v1/api-keys/${String(listed[0]?.id)}`, { cookie })
      expect(revoked.status).toBe(204)

      const response = await send('GET', `/v1/workspaces/${workspaceId}`, { bearer: secret })
      expect(response.status).toBe(401)
    })

    it('answers 401 for a secret nobody issued', async () => {
      const { workspaceId } = await owner()

      const response = await send('GET', `/v1/workspaces/${workspaceId}`, { bearer: 'kp_live_nonsense' })

      expect(response.status).toBe(401)
    })

    it('records last_used_at', async () => {
      const { cookie, workspaceId } = await owner()
      const secret = await mint(cookie, 'workspace')

      const [before] = await database.db.select().from(apiKeys)
      expect(before?.lastUsedAt).toBeNull()

      await send('GET', `/v1/workspaces/${workspaceId}`, { bearer: secret })

      const [after] = await database.db.select().from(apiKeys)
      expect(after?.lastUsedAt).toBeInstanceOf(Date)
    })

    it('cannot reach another workspace', async () => {
      const first = await owner('ada@example.com', 'acme')
      const second = await owner('grace@example.com', 'initech')
      const secret = await mint(first.cookie, 'workspace')

      const response = await send('GET', `/v1/workspaces/${second.workspaceId}`, { bearer: secret })

      expect(response.status).toBe(404)
    })

    it('is refused by endpoints that manage a person', async () => {
      const { cookie } = await owner()
      const secret = await mint(cookie, 'workspace')

      const response = await send('GET', '/v1/auth/sessions', { bearer: secret })

      expect(response.status).toBe(403)
    })

    it('wins over a cookie when both are sent', async () => {
      const first = await owner('ada@example.com', 'acme')
      const second = await owner('grace@example.com', 'initech')
      const secret = await mint(second.cookie, 'workspace')

      // The cookie belongs to Ada's workspace; the key belongs to Grace's.
      const response = await send('GET', `/v1/workspaces/${second.workspaceId}`, {
        bearer: secret,
        cookie: first.cookie,
      })

      expect(response.status).toBe(200)
    })
  })

  describe('a personal key', () => {
    it('acts as its user', async () => {
      const { cookie, workspaceId } = await owner()
      const secret = await mint(cookie, 'personal')

      const listed = readList(
        await (await send('GET', `/v1/workspaces/${workspaceId}/members`, { bearer: secret })).json(),
      )

      expect(listed).toHaveLength(1)
      expect(listed[0]?.role).toBe('owner')
    })

    it('stops working when its user leaves the workspace', async () => {
      const ownerAccount = await owner()
      const joinerCookie = await signUp('grace@example.com')

      await send('POST', `/v1/workspaces/${ownerAccount.workspaceId}/invites`, {
        body: {
          email: 'grace@example.com',
          role: 'member',
          invite_url_template: 'https://app.example.com/join?token={token}',
        },
        cookie: ownerAccount.cookie,
      })
      const token = /token=([^\s]+)/u.exec(harness.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''
      await send('POST', '/v1/invites/accept', { body: { token }, cookie: joinerCookie })

      const secret = await mint(joinerCookie, 'personal')
      expect(
        (await send('GET', `/v1/workspaces/${ownerAccount.workspaceId}`, { bearer: secret })).status,
      ).toBe(200)

      await database.db.delete(workspaceMembers)

      expect(
        (await send('GET', `/v1/workspaces/${ownerAccount.workspaceId}`, { bearer: secret })).status,
      ).toBe(401)
    })

    it('is not listed among workspace keys', async () => {
      const { cookie } = await owner()
      await mint(cookie, 'personal')

      const workspaceKeys = readList(
        await (await send('GET', '/v1/api-keys?kind=workspace', { cookie })).json(),
      )
      const personalKeys = readList(
        await (await send('GET', '/v1/api-keys?kind=personal', { cookie })).json(),
      )

      expect(workspaceKeys).toHaveLength(0)
      expect(personalKeys).toHaveLength(1)
    })

    it('is invisible to another member', async () => {
      const ownerAccount = await owner()
      await mint(ownerAccount.cookie, 'personal')

      const joinerCookie = await signUp('grace@example.com')
      await send('POST', `/v1/workspaces/${ownerAccount.workspaceId}/invites`, {
        body: {
          email: 'grace@example.com',
          role: 'admin',
          invite_url_template: 'https://app.example.com/join?token={token}',
        },
        cookie: ownerAccount.cookie,
      })
      const token = /token=([^\s]+)/u.exec(harness.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''
      await send('POST', '/v1/invites/accept', { body: { token }, cookie: joinerCookie })

      const theirs = readList(
        await (await send('GET', '/v1/api-keys?kind=personal', { cookie: joinerCookie })).json(),
      )

      expect(theirs).toHaveLength(0)
    })
  })

  describe('listing', () => {
    it('rejects a request that does not say which kind', async () => {
      const { cookie } = await owner()

      expect((await send('GET', '/v1/api-keys', { cookie })).status).toBe(422)
    })
  })
})

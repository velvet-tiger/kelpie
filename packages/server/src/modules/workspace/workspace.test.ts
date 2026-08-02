import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { handbookPages } from '../handbook/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { workspaceMembers } from './schema.ts'
import { STARTER_HANDBOOK_PAGES } from './starters.ts'

/** Workspace creation, membership, and invites against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

const WORKSPACE = { name: 'Acme', slug: 'acme', timezone: 'Australia/Melbourne' }
const INVITE_TEMPLATE = 'https://app.example.com/join?token={token}'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string') {
    throw new Error(`Expected "${key}" on ${JSON.stringify(payload)}`)
  }

  return payload[key]
}

function readList(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`Expected a list envelope, got ${JSON.stringify(payload)}`)
  }

  return payload.data
}

describe.skipIf(connectionString === undefined)('workspaces', () => {
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

  function send(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
    return Promise.resolve(
      harness.app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie === undefined ? {} : { Cookie: cookie }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  async function signUp(email: string): Promise<string> {
    const response = await send('POST', '/v1/auth/signup', {
      email,
      name: 'Someone',
      password: 'correct horse battery staple',
    })
    const header = response.headers.get('Set-Cookie')

    if (header === null) {
      throw new Error('Expected a session cookie')
    }

    return header.split(';')[0] ?? ''
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await send('POST', '/v1/workspaces', WORKSPACE, cookie)
    expect(response.status).toBe(201)

    return readString(await response.json(), 'id')
  }

  describe('creating a workspace', () => {
    it('makes the caller its owner', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const members = await database.db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))

      expect(members).toHaveLength(1)
      expect(members[0]?.role).toBe('owner')
    })

    it('moves the calling session into the new workspace', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const me = await (await send('GET', '/v1/auth/me', undefined, cookie)).json()

      expect(readString(me, 'workspace_id')).toBe(workspaceId)
      expect(readString(me, 'role')).toBe('owner')
    })

    it('seeds the starter handbook pages', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const pages = await database.db
        .select()
        .from(handbookPages)
        .where(eq(handbookPages.workspaceId, workspaceId))

      expect(pages).toHaveLength(STARTER_HANDBOOK_PAGES.length)
      expect(pages.map((page) => page.slug)).toContain('ideal-customer-profile')
    })

    it('seeds stages for all four pipelines', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const stages = await database.db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.workspaceId, workspaceId))

      expect(new Set(stages.map((stage) => stage.kind))).toEqual(
        new Set(['deal', 'opportunity', 'raise', 'partnership']),
      )
    })

    it('emits workspace.created after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('workspace.created', async (payload) => {
        seen.push(payload.slug)
      })

      await createWorkspace(await signUp('ada@example.com'))
      await harness.services.events.drain()

      expect(seen).toEqual(['acme'])
    })

    it('rejects a slug that is already taken', async () => {
      await createWorkspace(await signUp('ada@example.com'))

      const response = await send('POST', '/v1/workspaces', WORKSPACE, await signUp('grace@example.com'))

      expect(response.status).toBe(409)
    })

    it('rejects a slug that would not survive a URL', async () => {
      const response = await send(
        'POST',
        '/v1/workspaces',
        { ...WORKSPACE, slug: 'Not A Slug' },
        await signUp('ada@example.com'),
      )

      expect(response.status).toBe(422)
    })

    it('needs a session', async () => {
      expect((await send('POST', '/v1/workspaces', WORKSPACE)).status).toBe(401)
    })
  })

  describe('reading and updating a workspace', () => {
    it('returns 404 to someone who does not belong to it', async () => {
      const workspaceId = await createWorkspace(await signUp('ada@example.com'))
      const outsider = await signUp('mallory@example.com')

      const response = await send('GET', `/v1/workspaces/${workspaceId}`, undefined, outsider)

      expect(response.status).toBe(404)
    })

    it('lets an owner change the settings', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}`,
        { name: 'Acme Corporation', one_liner: 'We make anvils.' },
        cookie,
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(readString(body, 'name')).toBe('Acme Corporation')
      expect(readString(body, 'one_liner')).toBe('We make anvils.')
      expect(readString(body, 'slug')).toBe('acme')
    })
  })

  describe('invites', () => {
    it('emails a link and lists the invite', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const created = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'Grace@Example.com', role: 'member', invite_url_template: INVITE_TEMPLATE },
        cookie,
      )

      expect(created.status).toBe(201)
      expect(readString(await created.json(), 'email')).toBe('grace@example.com')
      expect(harness.services.sentEmails.at(-1)?.to).toBe('grace@example.com')

      const listed = await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)
      expect(readList(await listed.json())).toHaveLength(1)
    })

    it('refuses to invite an owner', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role: 'owner', invite_url_template: INVITE_TEMPLATE },
        cookie,
      )

      expect(response.status).toBe(422)
    })

    it('refuses an outsider trying to invite', async () => {
      const workspaceId = await createWorkspace(await signUp('ada@example.com'))

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'someone@example.com', role: 'member', invite_url_template: INVITE_TEMPLATE },
        await signUp('mallory@example.com'),
      )

      expect(response.status).toBe(404)
    })
  })

  describe('accepting an invite', () => {
    async function inviteToken(cookie: string, workspaceId: string, role: string): Promise<string> {
      await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role, invite_url_template: INVITE_TEMPLATE },
        cookie,
      )
      const body = harness.services.sentEmails.at(-1)?.body ?? ''
      const match = /token=([^\s]+)/u.exec(body)

      if (match?.[1] === undefined) {
        throw new Error(`No token in the invite email: ${body}`)
      }

      return match[1]
    }

    it('joins the workspace with the invited role', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const token = await inviteToken(owner, workspaceId, 'admin')
      const joiner = await signUp('grace@example.com')

      const accepted = await send('POST', '/v1/invites/accept', { token }, joiner)

      expect(accepted.status).toBe(200)
      expect(readString(await accepted.json(), 'id')).toBe(workspaceId)

      const me = await (await send('GET', '/v1/auth/me', undefined, joiner)).json()
      expect(readString(me, 'workspace_id')).toBe(workspaceId)
      expect(readString(me, 'role')).toBe('admin')
    })

    it('leaves exactly one owner in the workspace', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const token = await inviteToken(owner, workspaceId, 'admin')
      await send('POST', '/v1/invites/accept', { token }, await signUp('grace@example.com'))

      const members = await database.db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))

      expect(members).toHaveLength(2)
      expect(members.filter((member) => member.role === 'owner')).toHaveLength(1)
    })

    it('refuses a token that has already been accepted', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const token = await inviteToken(owner, workspaceId, 'member')
      await send('POST', '/v1/invites/accept', { token }, await signUp('grace@example.com'))

      const replay = await send('POST', '/v1/invites/accept', { token }, await signUp('mallory@example.com'))

      expect(replay.status).toBe(401)
    })

    it('refuses a token nobody issued', async () => {
      const response = await send(
        'POST',
        '/v1/invites/accept',
        { token: 'not-a-real-token' },
        await signUp('grace@example.com'),
      )

      expect(response.status).toBe(401)
    })

    it('refuses an expired invitation', async () => {
      const past = new Date('2026-01-01T00:00:00.000Z')
      const stale = await createTestApp({
        modules: coreModules,
        environment: { NODE_ENV: 'test' },
        services: createTestServices({ db: database.db, now: () => past }),
      })

      const signup = await stale.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' }),
      })
      const ownerCookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      const created = await stale.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify(WORKSPACE),
      })
      const workspaceId = readString(await created.json(), 'id')

      await stale.app.request(`/v1/workspaces/${workspaceId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          email: 'grace@example.com',
          role: 'member',
          invite_url_template: INVITE_TEMPLATE,
        }),
      })
      const token = /token=([^\s]+)/u.exec(stale.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''

      // The default harness clock is now, months past the seven-day window.
      const response = await send('POST', '/v1/invites/accept', { token }, await signUp('grace@example.com'))

      expect(response.status).toBe(401)
    })
  })
})

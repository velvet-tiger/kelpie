import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { coreModules } from '../core.ts'
import { handbookPages } from '../handbook/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { invites, workspaceMembers } from './schema.ts'
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

/** The `details` of an error body, as `api.md` shapes them. */
function readErrorFields(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.error) || !Array.isArray(payload.error.details)) {
    throw new Error(`Expected error details, got ${JSON.stringify(payload)}`)
  }

  return payload.error.details.map((detail: unknown) => readString(detail, 'field'))
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

  /** The token out of the most recent invitation email. */
  function lastInviteToken(): string {
    const body = harness.services.sentEmails.at(-1)?.body ?? ''
    const match = /token=([^\s]+)/u.exec(body)

    if (match?.[1] === undefined) {
      throw new Error(`No token in the invite email: ${body}`)
    }

    return match[1]
  }

  interface Joined {
    readonly cookie: string
    readonly memberId: string
  }

  /** Invites an address, accepts as a fresh account, and reports the membership. */
  async function addMember(
    ownerCookie: string,
    workspaceId: string,
    email: string,
    role: 'admin' | 'member',
  ): Promise<Joined> {
    const invited = await send(
      'POST',
      `/v1/workspaces/${workspaceId}/invites`,
      { email, role, invite_url_template: INVITE_TEMPLATE },
      ownerCookie,
    )
    expect(invited.status).toBe(201)

    const cookie = await signUp(email)
    const accepted = await send('POST', '/v1/invites/accept', { token: lastInviteToken() }, cookie)
    expect(accepted.status).toBe(200)

    const members = readList(await (await send('GET', `/v1/workspaces/${workspaceId}/members`, undefined, cookie)).json())
    const member = members.find((entry) => readString(entry, 'email') === email.toLowerCase())

    if (member === undefined) {
      throw new Error(`${email} accepted an invite but is not in the member list`)
    }

    return { cookie, memberId: readString(member, 'id') }
  }

  async function ownerMemberId(cookie: string, workspaceId: string): Promise<string> {
    const members = readList(await (await send('GET', `/v1/workspaces/${workspaceId}/members`, undefined, cookie)).json())
    const owner = members.find((entry) => readString(entry, 'role') === 'owner')

    if (owner === undefined) {
      throw new Error('The workspace has no owner')
    }

    return readString(owner, 'id')
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

    it('changes the slug', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { slug: 'acme-corp' }, cookie)

      expect(response.status).toBe(200)
      expect(readString(await response.json(), 'slug')).toBe('acme-corp')
    })

    it('refuses a slug another workspace already holds', async () => {
      await createWorkspace(await signUp('ada@example.com'))
      const other = await signUp('grace@example.com')
      const otherId = readString(
        await (await send('POST', '/v1/workspaces', { ...WORKSPACE, slug: 'globex' }, other)).json(),
        'id',
      )

      const response = await send('PATCH', `/v1/workspaces/${otherId}`, { slug: 'acme' }, other)

      expect(response.status).toBe(409)
      expect(readErrorFields(await response.json())).toEqual(['slug'])
    })

    it('refuses a slug that would not survive a URL', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { slug: 'Not A Slug' }, cookie)

      expect(response.status).toBe(422)
    })

    it('clears the agent identity strings when they are sent as null', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      await send('PATCH', `/v1/workspaces/${workspaceId}`, { tagline: 'Anvils that land' }, cookie)

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { tagline: null }, cookie)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ tagline: null })
    })

    it('refuses a member changing the settings', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { name: 'Mine now' }, grace.cookie)

      expect(response.status).toBe(403)
    })
  })

  describe('deleting a workspace', () => {
    it('takes the workspace and everything in it once the owner names it', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('DELETE', `/v1/workspaces/${workspaceId}?slug=acme`, undefined, cookie)

      expect(response.status).toBe(204)
      expect(
        await database.db.select().from(handbookPages).where(eq(handbookPages.workspaceId, workspaceId)),
      ).toHaveLength(0)
      expect(
        await database.db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
      ).toHaveLength(0)
    })

    it('leaves the signed-in account able to start again', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      await send('DELETE', `/v1/workspaces/${workspaceId}?slug=acme`, undefined, cookie)

      const me = await (await send('GET', '/v1/auth/me', undefined, cookie)).json()

      expect(me).toMatchObject({ workspace_id: null, role: null })
    })

    it('refuses a confirmation that does not match the slug', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('DELETE', `/v1/workspaces/${workspaceId}?slug=acme-corp`, undefined, cookie)

      expect(response.status).toBe(422)
      expect((await send('GET', `/v1/workspaces/${workspaceId}`, undefined, cookie)).status).toBe(200)
    })

    it('refuses an admin who is not the owner', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'admin')

      const response = await send('DELETE', `/v1/workspaces/${workspaceId}?slug=acme`, undefined, grace.cookie)

      expect(response.status).toBe(403)
    })

    it('emits workspace.deleted after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('workspace.deleted', async (payload) => {
        seen.push(payload.slug)
      })
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      await send('DELETE', `/v1/workspaces/${workspaceId}?slug=acme`, undefined, cookie)
      await harness.services.events.drain()

      expect(seen).toEqual(['acme'])
    })
  })

  describe('member roles', () => {
    it('lets an admin promote a member', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${grace.memberId}`,
        { role: 'admin' },
        owner,
      )

      expect(response.status).toBe(200)
      expect(readString(await response.json(), 'role')).toBe('admin')
      expect(readString(await (await send('GET', '/v1/auth/me', undefined, grace.cookie)).json(), 'role')).toBe('admin')
    })

    it('transfers ownership and leaves the outgoing owner an admin', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'admin')

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${grace.memberId}`,
        { role: 'owner' },
        owner,
      )

      expect(response.status).toBe(200)
      expect(readString(await response.json(), 'role')).toBe('owner')

      const members = await database.db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId))

      expect(members.filter((member) => member.role === 'owner')).toHaveLength(1)
      expect(readString(await (await send('GET', '/v1/auth/me', undefined, owner)).json(), 'role')).toBe('admin')
    })

    it('refuses an admin trying to hand ownership around', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'admin')
      const mallory = await addMember(owner, workspaceId, 'mallory@example.com', 'member')

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${mallory.memberId}`,
        { role: 'owner' },
        grace.cookie,
      )

      expect(response.status).toBe(403)
    })

    it('refuses demoting the owner', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const ownerId = await ownerMemberId(owner, workspaceId)

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${ownerId}`,
        { role: 'admin' },
        owner,
      )

      expect(response.status).toBe(409)
      expect(readString(await (await send('GET', '/v1/auth/me', undefined, owner)).json(), 'role')).toBe('owner')
    })

    it('refuses a member changing anybody', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${grace.memberId}`,
        { role: 'admin' },
        grace.cookie,
      )

      expect(response.status).toBe(403)
    })

    it('does not find a member of another workspace', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const outsider = await signUp('mallory@example.com')
      const otherId = readString(
        await (await send('POST', '/v1/workspaces', { ...WORKSPACE, slug: 'globex' }, outsider)).json(),
        'id',
      )
      const strangerId = await ownerMemberId(outsider, otherId)

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${strangerId}`,
        { role: 'admin' },
        owner,
      )

      expect(response.status).toBe(404)
    })
  })

  describe('removing a member', () => {
    it('takes their access with them', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const response = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${grace.memberId}`,
        undefined,
        owner,
      )

      expect(response.status).toBe(204)
      const me = await (await send('GET', '/v1/auth/me', undefined, grace.cookie)).json()
      expect(me).toMatchObject({ workspace_id: null, role: null })
    })

    it('emits member.removed after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('member.removed', async (payload) => {
        seen.push(payload.memberId)
      })
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      await send('DELETE', `/v1/workspaces/${workspaceId}/members/${grace.memberId}`, undefined, owner)
      await harness.services.events.drain()

      expect(seen).toEqual([grace.memberId])
    })

    it('refuses to remove the owner', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const ownerId = await ownerMemberId(owner, workspaceId)

      const response = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${ownerId}`,
        undefined,
        owner,
      )

      expect(response.status).toBe(409)
    })

    it('refuses while they still own records, and names what they own', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const created = await send(
        'POST',
        '/v1/opportunities',
        { name: 'Innovation grant', owner_id: grace.memberId },
        owner,
      )
      expect(created.status).toBe(201)

      const response = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${grace.memberId}`,
        undefined,
        owner,
      )

      expect(response.status).toBe(409)
      expect(readErrorFields(await response.json())).toEqual(['opportunity'])
    })

    it('refuses a member removing anybody', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')
      const mallory = await addMember(owner, workspaceId, 'mallory@example.com', 'member')

      const response = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${mallory.memberId}`,
        undefined,
        grace.cookie,
      )

      expect(response.status).toBe(403)
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

    it('refuses a member reading the invitation list', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const response = await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, grace.cookie)

      expect(response.status).toBe(403)
    })
  })

  describe('managing an invitation', () => {
    async function invite(cookie: string, workspaceId: string): Promise<string> {
      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role: 'member', invite_url_template: INVITE_TEMPLATE },
        cookie,
      )
      expect(response.status).toBe(201)

      return readString(await response.json(), 'id')
    }

    it('resends with a fresh token and retires the old one', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const inviteId = await invite(cookie, workspaceId)
      const first = lastInviteToken()

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites/${inviteId}/resend`,
        { invite_url_template: INVITE_TEMPLATE },
        cookie,
      )

      expect(response.status).toBe(200)
      const second = lastInviteToken()
      expect(second).not.toBe(first)
      expect(harness.services.sentEmails.at(-1)?.to).toBe('grace@example.com')

      const stale = await send('POST', '/v1/invites/accept', { token: first }, await signUp('grace@example.com'))
      expect(stale.status).toBe(401)

      const fresh = await send('POST', '/v1/invites/accept', { token: second }, await signUp('gracie@example.com'))
      expect(fresh.status).toBe(200)
    })

    it('revokes an invitation, and its link stops working', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const inviteId = await invite(cookie, workspaceId)
      const token = lastInviteToken()

      const response = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/invites/${inviteId}`,
        undefined,
        cookie,
      )

      expect(response.status).toBe(204)
      expect(
        readList(await (await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)).json()),
      ).toHaveLength(0)

      const accepted = await send('POST', '/v1/invites/accept', { token }, await signUp('grace@example.com'))
      expect(accepted.status).toBe(401)
    })

    it('refuses a member resending or revoking', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const inviteId = await invite(owner, workspaceId)
      const mallory = await addMember(owner, workspaceId, 'mallory@example.com', 'member')

      const resent = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites/${inviteId}/resend`,
        { invite_url_template: INVITE_TEMPLATE },
        mallory.cookie,
      )
      const revoked = await send(
        'DELETE',
        `/v1/workspaces/${workspaceId}/invites/${inviteId}`,
        undefined,
        mallory.cookie,
      )

      expect([resent.status, revoked.status]).toEqual([403, 403])
    })

    it('does not find an invitation belonging to another workspace', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const inviteId = await invite(owner, workspaceId)
      const outsider = await signUp('mallory@example.com')
      const otherId = readString(
        await (await send('POST', '/v1/workspaces', { ...WORKSPACE, slug: 'globex' }, outsider)).json(),
        'id',
      )

      const response = await send(
        'DELETE',
        `/v1/workspaces/${otherId}/invites/${inviteId}`,
        undefined,
        outsider,
      )

      expect(response.status).toBe(404)
    })

    it('reports an invitation past its expiry as expired', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const inviteId = await invite(cookie, workspaceId)

      // Aged in place rather than through the API, because no endpoint makes an
      // invitation old. Nothing sweeps the table, so the status is derived from
      // this column every time the list is read.
      await database.db
        .update(invites)
        .set({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(invites.id, inviteId))

      const listed = readList(
        await (await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)).json(),
      )

      expect(listed).toHaveLength(1)
      expect(readString(listed[0], 'status')).toBe('expired')
    })

    it('makes a resent invitation pending again', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const inviteId = await invite(cookie, workspaceId)
      await database.db
        .update(invites)
        .set({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(invites.id, inviteId))

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites/${inviteId}/resend`,
        { invite_url_template: INVITE_TEMPLATE },
        cookie,
      )

      expect(readString(await response.json(), 'status')).toBe('pending')
    })
  })

  describe('the seat limit', () => {
    it('does not bite when no module provides grants', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
        const response = await send(
          'POST',
          `/v1/workspaces/${workspaceId}/invites`,
          { email, role: 'member', invite_url_template: INVITE_TEMPLATE },
          cookie,
        )

        expect(response.status).toBe(201)
      }
    })

    it('refuses a new invitation once the seats are taken', async () => {
      // Two seats: the owner takes one, so the first invite fits and the second
      // does not. This is the shape the cloud billing module will register.
      const entitlements = createEntitlementRegistry()
      entitlements.provide(() => Promise.resolve({ kind: 'limit', limit: 2 }))

      const limited = await createTestApp({
        modules: coreModules,
        environment: { NODE_ENV: 'test' },
        services: createTestServices({ db: database.db }),
        entitlements,
      })

      const signup = await limited.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse battery' }),
      })
      const cookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      const created = await limited.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(WORKSPACE),
      })
      const workspaceId = readString(await created.json(), 'id')

      function invite(email: string): Promise<Response> {
        return Promise.resolve(
          limited.app.request(`/v1/workspaces/${workspaceId}/invites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ email, role: 'member', invite_url_template: INVITE_TEMPLATE }),
          }),
        )
      }

      expect((await invite('first@example.com')).status).toBe(201)

      const refused = await invite('second@example.com')
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { code: 'entitlement_required' } })
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

      return lastInviteToken()
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

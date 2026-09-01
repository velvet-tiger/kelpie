import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestServices } from '../../testing/services.ts'
import { hashToken } from '../../lib/tokens.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import { users } from '../auth/schema.ts'
import { coreModules } from '../core.ts'
import { handbookPages } from '../handbook/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'
import { invites, workspaceMembers } from './schema.ts'
import { STARTER_FORMS } from '../forms/starters.ts'
import { STARTER_LISTS } from '../lists/starters.ts'
import { STARTER_HANDBOOK_PAGES } from './starters.ts'

/** Workspace creation, membership, and invites against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

const WORKSPACE = { name: 'Acme', slug: 'acme', timezone: 'Australia/Melbourne' }

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

function readListIds(form: unknown): string[] {
  if (!isRecord(form) || !Array.isArray(form.list_ids)) {
    throw new Error(`Expected list_ids on ${JSON.stringify(form)}`)
  }

  return form.list_ids.map((id) => {
    if (typeof id !== 'string') {
      throw new Error(`Expected list id string, got ${JSON.stringify(id)}`)
    }
    return id
  })
}

/** The `details` of an error body, as `api.md` shapes them. */
function readErrorFields(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.error) || !Array.isArray(payload.error.details)) {
    throw new Error(`Expected error details, got ${JSON.stringify(payload)}`)
  }

  return payload.error.details.map((detail: unknown) => readString(detail, 'field'))
}

function readErrorCode(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    throw new Error(`Expected an error body, got ${JSON.stringify(payload)}`)
  }

  return readString(payload.error, 'code')
}

function findByModuleId(payload: unknown, moduleId: string): Record<string, unknown> {
  const setting = readList(payload).find((entry) => readString(entry, 'module_id') === moduleId)

  if (setting === undefined) {
    throw new Error(`No "${moduleId}" entry in ${JSON.stringify(payload)}`)
  }

  return setting as Record<string, unknown>
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
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
      resolveActor: (context) => resolveActorFrom({ db: database.db, now: () => new Date() }, context),
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

  interface SignedUp {
    readonly cookie: string
    readonly accountId: string
  }

  /** Signs up without verifying. Most tests want `signUp` below instead. */
  async function rawSignUp(email: string): Promise<SignedUp> {
    const response = await send('POST', '/v1/auth/signup', {
      email,
      name: 'Someone',
      password: 'correct horse battery staple',
    })
    const header = response.headers.get('Set-Cookie')

    if (header === null) {
      throw new Error('Expected a session cookie')
    }

    const payload: unknown = await response.json()

    if (!isRecord(payload) || !isRecord(payload.account) || typeof payload.account.id !== 'string') {
      throw new Error(`Expected a signed-up account, got ${JSON.stringify(payload)}`)
    }

    return { cookie: header.split(';')[0] ?? '', accountId: payload.account.id }
  }

  /**
   * Signs up and verifies directly against the database.
   *
   * This file is about workspaces, not verification, and creating one needs a
   * verified account. Verifying through the real emailed link would collide
   * with `lastInviteToken()`, which several invite tests below also rely on
   * reading the most recently sent email.
   */
  async function signUp(email: string): Promise<string> {
    const { cookie, accountId } = await rawSignUp(email)

    await database.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, accountId))

    return cookie
  }

  async function createWorkspace(cookie: string): Promise<string> {
    const response = await send('POST', '/v1/workspaces', WORKSPACE, cookie)
    expect(response.status).toBe(201)

    return readString(await response.json(), 'id')
  }

  /**
   * The token out of the most recent invitation email.
   *
   * Filtered by subject rather than just the last message sent: `signUp` also
   * sends a verification email, and `addMember` signs the invitee up after
   * inviting them, so the last message overall is not always the invite.
   */
  function lastInviteToken(): string {
    const body =
      harness.services.sentEmails
        .filter((message) => message.subject === 'You have been invited to a Kelpie workspace')
        .at(-1)?.body ?? ''
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
      { email, role },
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

    it('seeds stages for all five pipelines', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const stages = await database.db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.workspaceId, workspaceId))

      expect(new Set(stages.map((stage) => stage.kind))).toEqual(
        new Set(['enquiry', 'deal', 'opportunity', 'raise', 'partnership']),
      )
    })

    it('seeds the starter forms and newsletter list', async () => {
      const cookie = await signUp('ada@example.com')
      await createWorkspace(cookie)

      const formsResponse = await send('GET', '/v1/forms', undefined, cookie)
      const forms = readList(await formsResponse.json())

      expect(forms).toHaveLength(STARTER_FORMS.length)
      expect(forms.map((form) => readString(form, 'name')).sort()).toEqual(
        STARTER_FORMS.map((form) => form.name).sort(),
      )

      const contact = forms.find((form) => readString(form, 'name') === 'Contact')
      if (contact === undefined) {
        throw new Error('Expected the Contact starter form')
      }

      const contactFields = isRecord(contact) && Array.isArray(contact.fields) ? contact.fields : []
      expect(contactFields.map((field) => readString(field, 'map_to'))).toContain('person.phones')
      expect(contactFields.some((field) => readString(field, 'type') === 'consent')).toBe(true)

      const newsletter = forms.find((form) => readString(form, 'name') === 'Newsletter')
      if (newsletter === undefined) {
        throw new Error('Expected the Newsletter starter form')
      }

      expect(readListIds(newsletter)).toHaveLength(1)

      const listsResponse = await send('GET', '/v1/lists', undefined, cookie)
      const lists = readList(await listsResponse.json())

      expect(lists).toHaveLength(STARTER_LISTS.length)
      expect(lists.map((list) => readString(list, 'name'))).toEqual(
        STARTER_LISTS.map((list) => list.name),
      )
    })

    it('emits workspace.workspace.created after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('workspace.workspace.created', (event) => {
        seen.push(event.data.slug)
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

    it('rejects a timezone the platform cannot resolve', async () => {
      const response = await send(
        'POST',
        '/v1/workspaces',
        { ...WORKSPACE, timezone: 'Mars/Olympus' },
        await signUp('ada@example.com'),
      )

      expect(response.status).toBe(422)
      expect(readErrorFields(await response.json())).toEqual(['timezone'])
    })

    it('needs a session', async () => {
      expect((await send('POST', '/v1/workspaces', WORKSPACE)).status).toBe(401)
    })

    it('refuses an account that has not verified its email', async () => {
      const { cookie } = await rawSignUp('ada@example.com')

      const response = await send('POST', '/v1/workspaces', WORKSPACE, cookie)

      expect(response.status).toBe(403)
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
        { name: 'Acme Corporation' },
        cookie,
      )

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(readString(body, 'name')).toBe('Acme Corporation')
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

    it('changes the timezone', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { timezone: 'Europe/London' }, cookie)

      expect(response.status).toBe(200)
      expect(readString(await response.json(), 'timezone')).toBe('Europe/London')
    })

    it('refuses a timezone the platform cannot resolve', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send('PATCH', `/v1/workspaces/${workspaceId}`, { timezone: 'Mars/Olympus' }, cookie)

      expect(response.status).toBe(422)
      expect(readErrorFields(await response.json())).toEqual(['timezone'])
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

    it('emits workspace.workspace.deleted after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('workspace.workspace.deleted', (event) => {
        seen.push(event.data.slug)
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

    it('emits workspace.member.removed after the transaction commits', async () => {
      const seen: string[] = []
      harness.services.events.subscribe('workspace.member.removed', (event) => {
        seen.push(event.target.id)
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
        { email: 'Grace@Example.com', role: 'member' },
        cookie,
      )

      expect(created.status).toBe(201)
      expect(readString(await created.json(), 'email')).toBe('grace@example.com')
      expect(harness.services.sentEmails.at(-1)?.to).toBe('grace@example.com')
      // The link is built server-side from APP_BASE_URL, not from a caller value.
      expect(harness.services.sentEmails.at(-1)?.body).toContain(`${TEST_APP_BASE_URL}/join?token=`)

      const listed = await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)
      expect(readList(await listed.json())).toHaveLength(1)
    })

    it('refuses to invite an owner', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role: 'owner' },
        cookie,
      )

      expect(response.status).toBe(422)
    })

    it('refuses an address that already belongs to a member', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      // Signing up already sent one verification email; the refusal below must add none.
      const sentBeforeInviting = harness.services.sentEmails.length

      // Mixed case on purpose: the address is normalised before the lookup, and
      // `users.email` is citext, so neither half can be fooled by capitals.
      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'Ada@Example.com', role: 'admin' },
        cookie,
      )

      expect(response.status).toBe(409)
      expect(readErrorFields(await response.json())).toEqual(['email'])

      // Nothing was written and nothing was sent: the refusal is the whole of it.
      const listed = await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)
      expect(readList(await listed.json())).toHaveLength(0)
      expect(harness.services.sentEmails).toHaveLength(sentBeforeInviting)
    })

    it('refuses an address that is already invited', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      // Signing up already sent one verification email; only the accepted invite adds another.
      const sentBeforeInviting = harness.services.sentEmails.length
      const body = { email: 'grace@example.com', role: 'member' }

      expect((await send('POST', `/v1/workspaces/${workspaceId}/invites`, body, cookie)).status).toBe(201)

      const repeated = await send('POST', `/v1/workspaces/${workspaceId}/invites`, body, cookie)

      expect(repeated.status).toBe(409)
      expect(readErrorFields(await repeated.json())).toEqual(['email'])
      expect(harness.services.sentEmails).toHaveLength(sentBeforeInviting + 1)
    })

    it('replaces an expired invitation rather than listing the address twice', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const body = { email: 'grace@example.com', role: 'member' }
      const first = await send('POST', `/v1/workspaces/${workspaceId}/invites`, body, cookie)
      const staleToken = lastInviteToken()

      // Aged in place: no endpoint makes an invitation old.
      await database.db
        .update(invites)
        .set({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })
        .where(eq(invites.id, readString(await first.json(), 'id')))

      const again = await send('POST', `/v1/workspaces/${workspaceId}/invites`, body, cookie)
      expect(again.status).toBe(201)

      const listed = readList(
        await (await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, cookie)).json(),
      )
      expect(listed).toHaveLength(1)
      expect(readString(listed[0], 'status')).toBe('pending')

      const stale = await send('POST', '/v1/invites/accept', { token: staleToken }, await signUp('grace@example.com'))
      expect(stale.status).toBe(401)
    })

    it('refuses an outsider trying to invite', async () => {
      const workspaceId = await createWorkspace(await signUp('ada@example.com'))

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'someone@example.com', role: 'member' },
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

    it('verifies the joining account on accept, with no separate link needed', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role: 'member' },
        owner,
      )

      const { cookie } = await rawSignUp('grace@example.com')
      const accepted = await send('POST', '/v1/invites/accept', { token: lastInviteToken() }, cookie)
      expect(accepted.status).toBe(200)

      const account = await send('GET', '/v1/account', undefined, cookie)
      expect(await account.json()).toMatchObject({ email_verified: true })

      // Verified now means allowed through the same gate `rawSignUp` alone hits.
      const created = await send('POST', '/v1/workspaces', { ...WORKSPACE, slug: 'other' }, cookie)
      expect(created.status).toBe(201)
    })

    it('builds the invite link from services.appBaseUrl when set, ignoring APP_BASE_URL in the environment', async () => {
      // The assembly's `kelpie.config.ts` supplies `appBaseUrl` through
      // services. The env var still holds a different value, so the assertion
      // proves services wins — the two values are picked to be visibly
      // different in the emailed link.
      const SERVICES_URL = 'https://services-wins.example'
      const overridden = await createTestApp({
        modules: coreModules,
        environment: { ...TEST_ENVIRONMENT, APP_BASE_URL: 'https://env-loses.example' },
        services: createTestServices({ db: database.db, appBaseUrl: SERVICES_URL }),
      })

      const signupResponse = await overridden.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ada-precedence@example.com',
          name: 'Ada',
          password: 'correct horse battery staple',
        }),
      })
      expect(signupResponse.status).toBe(201)
      const signupCookie = signupResponse.headers.get('Set-Cookie')?.split(';')[0] ?? ''
      const signupPayload: unknown = await signupResponse.json()
      const accountId = isRecord(signupPayload) && isRecord(signupPayload.account) && typeof signupPayload.account.id === 'string' ? signupPayload.account.id : ''
      await database.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, accountId))

      const workspaceResponse = await overridden.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: signupCookie },
        body: JSON.stringify({ ...WORKSPACE, slug: 'precedence' }),
      })
      expect(workspaceResponse.status).toBe(201)
      const workspaceId = readString(await workspaceResponse.json(), 'id')

      const inviteResponse = await overridden.app.request(`/v1/workspaces/${workspaceId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: signupCookie },
        body: JSON.stringify({ email: 'grace-precedence@example.com', role: 'member' }),
      })
      expect(inviteResponse.status).toBe(201)

      const body =
        overridden.services.sentEmails
          .filter((message) => message.subject === 'You have been invited to a Kelpie workspace')
          .at(-1)?.body ?? ''
      expect(body).toContain(`${SERVICES_URL}/join?token=`)
      expect(body).not.toContain('env-loses.example')
    })
  })

  describe('managing an invitation', () => {
    async function invite(cookie: string, workspaceId: string): Promise<string> {
      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'grace@example.com', role: 'member' },
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
        {},
        cookie,
      )

      expect(response.status).toBe(200)
      const second = lastInviteToken()
      expect(second).not.toBe(first)
      expect(harness.services.sentEmails.at(-1)?.to).toBe('grace@example.com')

      const stale = await send('POST', '/v1/invites/accept', { token: first }, await signUp('mallory@example.com'))
      expect(stale.status).toBe(401)

      const fresh = await send('POST', '/v1/invites/accept', { token: second }, await signUp('grace@example.com'))
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
        {},
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
        {},
        cookie,
      )

      expect(readString(await response.json(), 'status')).toBe('pending')
    })

    it('refuses to resend an invitation whose address now belongs to a member', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      await addMember(owner, workspaceId, 'grace@example.com', 'member')

      // No endpoint can create this state today: `invite()` refuses an address
      // that already belongs to a member. This reproduces a row written before
      // that guard existed, for somebody who has since joined.
      const [legacy] = await database.db
        .insert(invites)
        .values({
          id: 'invite_legacy_test',
          workspaceId,
          email: 'grace@example.com',
          role: 'member',
          status: 'pending',
          tokenHash: hashToken('stale-token'),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        })
        .returning()

      if (legacy === undefined) {
        throw new Error('Insert did not return the row')
      }

      const sentBefore = harness.services.sentEmails.length

      const response = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites/${legacy.id}/resend`,
        {},
        owner,
      )

      expect(response.status).toBe(409)
      expect(readErrorFields(await response.json())).toEqual(['email'])
      expect(harness.services.sentEmails).toHaveLength(sentBefore)
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
          { email, role: 'member' },
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
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
        entitlements,
      })

      const signup = await limited.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          name: 'Ada',
          password: 'correct horse battery',
            }),
      })
      const cookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      const signedUp: unknown = await signup.json()

      if (!isRecord(signedUp) || !isRecord(signedUp.account) || typeof signedUp.account.id !== 'string') {
        throw new Error(`Expected a signed-up account, got ${JSON.stringify(signedUp)}`)
      }

      await database.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, signedUp.account.id))

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
            body: JSON.stringify({ email, role: 'member' }),
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
        { email: 'grace@example.com', role },
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

    it('refuses a token from somebody who already belongs, and leaves the invitation alive', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      const grace = await addMember(owner, workspaceId, 'grace@example.com', 'member')

      const invited = await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'henry@example.com', role: 'member' },
        owner,
      )
      expect(invited.status).toBe(201)

      const response = await send('POST', '/v1/invites/accept', { token: lastInviteToken() }, grace.cookie)

      expect(response.status).toBe(409)

      // Henry's, not Grace's. Her clicking his link must not take it from him.
      const listed = readList(
        await (await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, owner)).json(),
      )
      expect(listed).toHaveLength(1)
      expect(readString(listed[0], 'email')).toBe('henry@example.com')
    })

    it('refuses a token whose address does not match the accepting account, and leaves it alive for the real invitee', async () => {
      const owner = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(owner)
      await send(
        'POST',
        `/v1/workspaces/${workspaceId}/invites`,
        { email: 'henry@example.com', role: 'admin' },
        owner,
      )
      const henryToken = lastInviteToken()

      // Grace clicks the link addressed to Henry. An invitation names an
      // address, not a person: accepting it as somebody else would let a
      // leaked or forwarded token seat anyone, and would let that account
      // claim credit for proving control of an address it never controlled.
      const mismatched = await send(
        'POST',
        '/v1/invites/accept',
        { token: henryToken },
        await signUp('grace@example.com'),
      )
      expect(mismatched.status).toBe(401)

      const listed = readList(
        await (await send('GET', `/v1/workspaces/${workspaceId}/invites`, undefined, owner)).json(),
      )
      expect(listed).toHaveLength(1)
      expect(readString(listed[0], 'email')).toBe('henry@example.com')

      // Henry's own link still works.
      const accepted = await send(
        'POST',
        '/v1/invites/accept',
        { token: henryToken },
        await signUp('henry@example.com'),
      )
      expect(accepted.status).toBe(200)
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
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db, now: () => past }),
      })

      const signup = await stale.app.request('/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          name: 'Ada',
          password: 'correct horse battery',
            }),
      })
      const ownerCookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      const signedUp: unknown = await signup.json()

      if (!isRecord(signedUp) || !isRecord(signedUp.account) || typeof signedUp.account.id !== 'string') {
        throw new Error(`Expected a signed-up account, got ${JSON.stringify(signedUp)}`)
      }

      await database.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, signedUp.account.id))

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
        }),
      })
      const token = /token=([^\s]+)/u.exec(stale.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''

      // The default harness clock is now, months past the seven-day window.
      const response = await send('POST', '/v1/invites/accept', { token }, await signUp('grace@example.com'))

      expect(response.status).toBe(401)
    })
  })

  describe('module settings', () => {
    it('lists every toggleable module as enabled by default', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const list = readList(await (await send('GET', `/v1/workspaces/${workspaceId}/modules`, undefined, cookie)).json())

      expect(list.length).toBeGreaterThan(0)
      expect(list.every((entry) => readString(entry, 'module_id').length > 0)).toBe(true)
      const deals = findByModuleId(
        await (await send('GET', `/v1/workspaces/${workspaceId}/modules`, undefined, cookie)).json(),
        'deals',
      )
      expect(deals).toMatchObject({ enabled: true, locked: false })

      // Structural modules never appear: there is nothing for the settings
      // screen to offer a checkbox for.
      expect(list.some((entry) => readString(entry, 'module_id') === 'people')).toBe(false)
    })

    it('blocks the disabled module\'s own REST routes once toggled off, and restores them when toggled back on', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      expect((await send('GET', '/v1/deals', undefined, cookie)).status).toBe(200)

      const disabled = await send('PATCH', `/v1/workspaces/${workspaceId}/modules/deals`, { enabled: false }, cookie)
      expect(disabled.status).toBe(200)
      expect(await disabled.json()).toEqual({ module_id: 'deals', enabled: false, locked: false })

      const blocked = await send('GET', '/v1/deals', undefined, cookie)
      expect(blocked.status).toBe(403)
      expect(readErrorCode(await blocked.json())).toBe('entitlement_required')

      const reEnabled = await send('PATCH', `/v1/workspaces/${workspaceId}/modules/deals`, { enabled: true }, cookie)
      expect(reEnabled.status).toBe(200)
      expect((await send('GET', '/v1/deals', undefined, cookie)).status).toBe(200)
    })

    it('rejects toggling a structural or unknown module id', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)

      const structural = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/modules/people`,
        { enabled: false },
        cookie,
      )
      expect(structural.status).toBe(404)

      const unknown = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/modules/not-a-module`,
        { enabled: false },
        cookie,
      )
      expect(unknown.status).toBe(404)
    })

    it('refuses a non-admin member toggling a module', async () => {
      const cookie = await signUp('ada@example.com')
      const workspaceId = await createWorkspace(cookie)
      const { cookie: memberCookie } = await addMember(cookie, workspaceId, 'grace@example.com', 'member')

      const response = await send(
        'PATCH',
        `/v1/workspaces/${workspaceId}/modules/deals`,
        { enabled: false },
        memberCookie,
      )

      expect(response.status).toBe(403)
    })

    it('reports a config-locked module and refuses to toggle it', async () => {
      const locked = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
        resolveActor: (context) => resolveActorFrom({ db: database.db, now: () => new Date() }, context),
        moduleConfig: { deals: false },
      })

      const send2 = (method: string, path: string, body?: unknown, cookie?: string): Promise<Response> =>
        Promise.resolve(
          locked.app.request(path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(cookie === undefined ? {} : { Cookie: cookie }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        )

      const signup = await send2('POST', '/v1/auth/signup', {
        email: 'ada@example.com',
        name: 'Ada',
        password: 'correct horse battery staple',
        })
      const cookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      const signedUp: unknown = await signup.json()

      if (!isRecord(signedUp) || !isRecord(signedUp.account) || typeof signedUp.account.id !== 'string') {
        throw new Error(`Expected a signed-up account, got ${JSON.stringify(signedUp)}`)
      }

      await database.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, signedUp.account.id))

      const created = await send2('POST', '/v1/workspaces', WORKSPACE, cookie)
      const workspaceId = readString(await created.json(), 'id')

      const settings = await (await send2('GET', `/v1/workspaces/${workspaceId}/modules`, undefined, cookie)).json()
      expect(findByModuleId(settings, 'deals')).toMatchObject({ enabled: false, locked: true })

      const attempt = await send2(
        'PATCH',
        `/v1/workspaces/${workspaceId}/modules/deals`,
        { enabled: true },
        cookie,
      )
      expect(attempt.status).toBe(409)

      expect((await send2('GET', '/v1/deals', undefined, cookie)).status).toBe(403)
    })
  })
})

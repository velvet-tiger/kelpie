import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppError } from '../../lib/errors.ts'
import { hashToken } from '../../lib/tokens.ts'
import type { AnyEventEnvelope } from '../../runtime/events.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_APP_BASE_URL, TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { apiKeys } from '../api-keys/schema.ts'
import { coreModules } from '../core.ts'
import { enquiries } from '../enquiries/schema.ts'
import { notes } from '../notes/schema.ts'
import { oauthClients, oauthConnections, oauthGrants, oauthTokens } from '../oauth/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { workspaceMembers } from '../workspace/schema.ts'
import {
  ACCOUNT_DELETION_EXIT_DELETED,
  ACCOUNT_DELETION_EXIT_REFUSED,
  ACCOUNT_DELETION_EXIT_UNKNOWN,
  runAccountDeletion,
} from './operatorDeletion.ts'
import { sessions, userPreferences, users } from './schema.ts'

/**
 * Deleting an account, by the account itself and by an operator, against
 * real Postgres. Driven through HTTP and the operator function, with a
 * fixture module that refuses on request, the way a cloud module would.
 */

const connectionString = testDatabaseUrl(process.env)

/** The password `createTestClient` signs every account up with. */
const PASSWORD = 'correct horse battery staple'

describe.skipIf(connectionString === undefined)('account deletion', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let published: AnyEventEnvelope[]
  /** When set, the fixture handler refuses with it. */
  let refusal: AppError | undefined
  /** Every account the fixture handler saw being deleted. */
  let handled: string[]

  /** Stands in for a module outside core that holds rows about an account. */
  const fixtureModule: KelpieModule = {
    id: 'deletion-fixture',
    // After `workspace`, so its handler runs after membership's and a
    // refusal here has something of membership's to roll back.
    requires: ['workspace'],
    structural: true,

    register(context) {
      context.handleAccountDeletion((deletion) => {
        handled.push(deletion.userId)

        return refusal === undefined ? Promise.resolve() : Promise.reject(refusal)
      })

      return Promise.resolve()
    },
  }

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
    published = []
    refusal = undefined
    handled = []

    const services = createTestServices({ db: database.db })
    services.events.subscribePrefix('auth.', (event) => {
      published.push(event)
    })
    services.events.subscribe('workspace.member.removed', (event) => {
      published.push(event)
    })

    harness = await createTestApp({
      modules: [...coreModules, fixtureModule],
      environment: TEST_ENVIRONMENT,
      services,
    })
    client = createTestClient(harness.app, database.db)
  })

  async function eventsSoFar(): Promise<readonly AnyEventEnvelope[]> {
    await harness.services.events.drain()

    return published
  }

  async function accountIdOf(cookie: string): Promise<string> {
    return readString(await (await client.send('GET', '/v1/auth/me', { cookie })).json(), 'user_id')
  }

  /** Makes the account a member of the workspace and moves its session there. */
  async function join(cookie: string, workspaceId: string, role: 'admin' | 'member' = 'member'): Promise<string> {
    const memberId = harness.services.createId('teamMember')

    await database.db
      .insert(workspaceMembers)
      .values({ id: memberId, workspaceId, userId: await accountIdOf(cookie), role })

    const switched = await client.send('POST', '/v1/auth/workspace', {
      body: { workspace_id: workspaceId },
      cookie,
    })
    expect(switched.status).toBe(200)

    return memberId
  }

  async function mintKey(cookie: string, kind: 'personal' | 'workspace'): Promise<string> {
    const minted = await client.send('POST', '/v1/api-keys', {
      body: { name: `${kind} key`, kind, full_access: true },
      cookie,
    })
    expect(minted.status).toBe(201)

    return readString(await minted.json(), 'secret')
  }

  /** A connected app for the account in one workspace, written as the consent page would. */
  async function connectApp(userId: string, workspaceId: string): Promise<void> {
    await database.db.insert(oauthClients).values({
      id: 'oac_test',
      clientId: 'client-test',
      kind: 'registered',
      clientName: 'Test client',
      redirectUris: ['https://client.example/callback'],
    })
    await database.db.insert(oauthConnections).values({ id: 'ocn_test', userId, clientRowId: 'oac_test' })
    await database.db.insert(oauthGrants).values({
      id: 'ogr_test',
      workspaceId,
      userId,
      clientRowId: 'oac_test',
      connectionId: 'ocn_test',
      scopes: ['people:read'],
    })
    await database.db.insert(oauthTokens).values({
      id: 'oat_test',
      connectionId: 'ocn_test',
      kind: 'refresh',
      tokenHash: hashToken('not-a-real-refresh-token'),
      resource: `${TEST_APP_BASE_URL}/mcp`,
      scopes: ['people:read'],
      expiresAt: new Date('2999-01-01T00:00:00.000Z'),
    })
  }

  function deleteAccount(
    credentials: { readonly cookie?: string; readonly bearer?: string },
    password = PASSWORD,
  ): Promise<Response> {
    return client.send('DELETE', '/v1/account', { body: { current_password: password }, ...credentials })
  }

  async function accountExists(userId: string): Promise<boolean> {
    return (await database.db.select({ id: users.id }).from(users).where(eq(users.id, userId))).length === 1
  }

  /** Two workspaces, each with its own owner, and Grace a member of both, holding records in the first. */
  async function graceInTwoWorkspaces(): Promise<{
    readonly cookie: string
    readonly userId: string
    readonly acme: { readonly workspaceId: string; readonly cookie: string; readonly memberId: string }
    readonly globex: { readonly workspaceId: string; readonly memberId: string }
  }> {
    const acme = await client.owner('ada@example.com')
    const globex = await client.owner('bob@example.com')
    const cookie = await client.signUp('Grace@Example.com')
    const userId = await accountIdOf(cookie)
    const globexMember = await join(cookie, globex.workspaceId)
    const acmeMember = await join(cookie, acme.workspaceId)

    return {
      cookie,
      userId,
      acme: { workspaceId: acme.workspaceId, cookie: acme.cookie, memberId: acmeMember },
      globex: { workspaceId: globex.workspaceId, memberId: globexMember },
    }
  }

  describe('by the account itself', () => {
    it('deletes the account and what hangs off it, and keeps the workspace records with nobody named', async () => {
      const grace = await graceInTwoWorkspaces()
      const acme = grace.acme

      const opportunity = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Innovation grant', owner_id: acme.memberId },
        cookie: acme.cookie,
      })
      expect(opportunity.status).toBe(201)
      const enquiry = await client.send('POST', '/v1/enquiries', {
        body: { name: 'Website demo request', owner_id: acme.memberId },
        cookie: acme.cookie,
      })
      expect(enquiry.status).toBe(201)
      const person = await client.send('POST', '/v1/people', { body: { name: 'Linus Torvalds' }, cookie: grace.cookie })
      const note = await client.send('POST', '/v1/notes', {
        body: { target_type: 'person', target_id: readString(await person.json(), 'id'), body: 'Met at the meetup.' },
        cookie: grace.cookie,
      })
      expect(note.status).toBe(201)

      const preferences = await client.send('PATCH', '/v1/account/preferences', {
        body: { theme: 'dark' },
        cookie: grace.cookie,
      })
      expect(preferences.status).toBe(200)
      await mintKey(grace.cookie, 'personal')
      const workspaceKey = await mintKey(acme.cookie, 'workspace')
      await connectApp(grace.userId, acme.workspaceId)
      const secondLogin = await client.send('POST', '/v1/auth/login', {
        body: { email: 'grace@example.com', password: PASSWORD },
      })
      const secondCookie = (secondLogin.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
      expect(secondLogin.status).toBe(200)

      const response = await deleteAccount({ cookie: grace.cookie })

      expect(response.status).toBe(204)
      expect(response.headers.get('Set-Cookie')).toMatch(/kelpie_session=;.*Max-Age=0/u)
      expect(await accountExists(grace.userId)).toBe(false)
      expect(await database.db.select().from(sessions).where(eq(sessions.userId, grace.userId))).toEqual([])
      expect(await database.db.select().from(userPreferences)).toEqual([])
      expect(await database.db.select().from(apiKeys).where(eq(apiKeys.userId, grace.userId))).toEqual([])
      expect(await database.db.select().from(oauthConnections)).toEqual([])
      expect(await database.db.select().from(oauthGrants)).toEqual([])
      expect(await database.db.select().from(oauthTokens)).toEqual([])
      expect(
        await database.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, grace.userId)),
      ).toEqual([])

      const [opportunityRow] = await database.db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, readString(await opportunity.json(), 'id')))
      const [enquiryRow] = await database.db
        .select()
        .from(enquiries)
        .where(eq(enquiries.id, readString(await enquiry.json(), 'id')))
      const [noteRow] = await database.db
        .select()
        .from(notes)
        .where(eq(notes.id, readString(await note.json(), 'id')))
      expect(opportunityRow?.ownerId).toBeNull()
      expect(enquiryRow?.ownerId).toBeNull()
      expect(noteRow).toMatchObject({ authorId: null, origin: 'member', body: 'Met at the meetup.' })

      // The other session went with the account, and the workspace key did not.
      expect((await client.send('GET', '/v1/auth/me', { cookie: secondCookie })).status).toBe(401)
      expect((await client.send('GET', '/v1/people', { bearer: workspaceKey })).status).toBe(200)
      expect(handled).toEqual([grace.userId])
    })

    it('publishes auth.user.deleted with no workspace, and a member removal for each workspace', async () => {
      const grace = await graceInTwoWorkspaces()
      await eventsSoFar()
      published = []

      expect((await deleteAccount({ cookie: grace.cookie })).status).toBe(204)

      const events = await eventsSoFar()

      expect(events.filter((event) => event.name === 'auth.user.deleted')).toEqual([
        expect.objectContaining({
          workspaceId: null,
          actor: { kind: 'user', id: grace.userId },
          target: { type: 'user', id: grace.userId },
          data: { userId: grace.userId, email: 'grace@example.com' },
        }),
      ])
      expect(
        events
          .filter((event) => event.name === 'workspace.member.removed')
          .map((event) => ({ workspaceId: event.workspaceId, target: event.target, data: event.data }))
          .toSorted((left, right) => String(left.workspaceId).localeCompare(String(right.workspaceId))),
      ).toEqual(
        [
          {
            workspaceId: grace.acme.workspaceId,
            target: { type: 'member', id: grace.acme.memberId },
            data: { userId: grace.userId },
          },
          {
            workspaceId: grace.globex.workspaceId,
            target: { type: 'member', id: grace.globex.memberId },
            data: { userId: grace.userId },
          },
        ].toSorted((left, right) => left.workspaceId.localeCompare(right.workspaceId)),
      )
    })

    it('refuses an account that owns a workspace, names the workspace, and deletes nothing', async () => {
      const ada = await client.owner('ada@example.com')
      const adaId = await accountIdOf(ada.cookie)
      await eventsSoFar()
      published = []

      const response = await deleteAccount({ cookie: ada.cookie })

      expect(response.status).toBe(409)
      expect(readRecord(await response.json()).error).toEqual({
        code: 'conflict',
        message: 'This account owns a workspace. Give ownership to another member, or delete the workspace, first',
        details: [{ field: ada.workspaceId, message: 'Acme' }],
      })
      expect(await accountExists(adaId)).toBe(true)
      expect((await client.send('GET', '/v1/auth/me', { cookie: ada.cookie })).status).toBe(200)
      expect(await eventsSoFar()).toEqual([])
    })

    it('rolls everything back when a later module refuses', async () => {
      const grace = await graceInTwoWorkspaces()
      const opportunity = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Innovation grant', owner_id: grace.acme.memberId },
        cookie: grace.acme.cookie,
      })
      await eventsSoFar()
      published = []
      refusal = AppError.conflict('This account has an open invoice')

      const response = await deleteAccount({ cookie: grace.cookie })

      expect(response.status).toBe(409)
      expect(readRecord(await response.json()).error).toMatchObject({
        message: 'This account has an open invoice',
      })
      expect(await accountExists(grace.userId)).toBe(true)

      // The workspace handler ran first and cleared the owner. The refusal undid it.
      const [row] = await database.db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, readString(await opportunity.json(), 'id')))
      expect(row?.ownerId).toBe(grace.acme.memberId)
      expect(
        await database.db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, grace.userId)),
      ).toHaveLength(2)
      expect(await eventsSoFar()).toEqual([])
    })

    it('refuses a wrong password', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)

      const response = await deleteAccount({ cookie }, 'not the password')

      expect(response.status).toBe(401)
      expect(readRecord(await response.json()).error).toMatchObject({ message: 'Current password is incorrect' })
      expect(await accountExists(userId)).toBe(true)
      expect(handled).toEqual([])
    })

    it('refuses an account with no password, which sets one through the reset flow first', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)
      await database.db.update(users).set({ passwordHash: null }).where(eq(users.id, userId))

      const response = await deleteAccount({ cookie })

      expect(response.status).toBe(401)
      expect(await accountExists(userId)).toBe(true)
    })

    it('refuses an API key, even one that acts as the account', async () => {
      const ada = await client.owner('ada@example.com')
      const adaId = await accountIdOf(ada.cookie)
      const personalKey = await mintKey(ada.cookie, 'personal')

      const response = await deleteAccount({ bearer: personalKey })

      expect(response.status).toBe(403)
      expect(await accountExists(adaId)).toBe(true)
      expect(handled).toEqual([])
    })

    it('refuses an OAuth token', async () => {
      const ada = await client.owner('ada@example.com')
      const adaId = await accountIdOf(ada.cookie)

      const response = await deleteAccount({ bearer: 'kp_oat_not-for-the-rest-api' })

      expect(response.status).toBe(401)
      expect(await accountExists(adaId)).toBe(true)
    })

    it('refuses a request with no session', async () => {
      const ada = await client.owner('ada@example.com')
      const adaId = await accountIdOf(ada.cookie)

      const response = await deleteAccount({})

      expect(response.status).toBe(401)
      expect(await accountExists(adaId)).toBe(true)
    })

    it('offers no MCP tool that reaches the account', () => {
      expect(harness.contributions.mcpTools.map((tool) => tool.name).filter((name) => name.includes('account'))).toEqual(
        [],
      )
    })
  })

  describe('by an operator', () => {
    async function runFor(email: string): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
      const lines: string[] = []
      const code = await runAccountDeletion({
        db: database.db,
        transaction: harness.services.transaction,
        runAccountDeletionHandlers: harness.contributions.runAccountDeletionHandlers,
        email,
        report: (line) => lines.push(line),
        reportFatal: (line) => lines.push(line),
      })

      return { code, lines }
    }

    it('deletes by address, with no password, and publishes the event as the system', async () => {
      const grace = await graceInTwoWorkspaces()
      await database.db.update(users).set({ passwordHash: null }).where(eq(users.id, grace.userId))
      await eventsSoFar()
      published = []

      const { code, lines } = await runFor('  GRACE@example.com ')

      expect(code).toBe(ACCOUNT_DELETION_EXIT_DELETED)
      expect(lines).toEqual([`Deleted account ${grace.userId} (grace@example.com).`])
      expect(await accountExists(grace.userId)).toBe(false)

      const events = await eventsSoFar()
      expect(events.find((event) => event.name === 'auth.user.deleted')).toMatchObject({
        workspaceId: null,
        actor: { kind: 'system' },
        data: { userId: grace.userId, email: 'grace@example.com' },
      })
      expect(events.filter((event) => event.name === 'workspace.member.removed')).toHaveLength(2)
    })

    it('refuses an owner, and prints the workspace', async () => {
      const ada = await client.owner('ada@example.com')
      const adaId = await accountIdOf(ada.cookie)

      const { code, lines } = await runFor('ada@example.com')

      expect(code).toBe(ACCOUNT_DELETION_EXIT_REFUSED)
      expect(lines).toEqual([
        'Refused: This account owns a workspace. Give ownership to another member, or delete the workspace, first. Nothing was deleted.',
        `  ${ada.workspaceId}: Acme`,
      ])
      expect(await accountExists(adaId)).toBe(true)
    })

    it('reports an address no account has', async () => {
      await client.signUp('grace@example.com')

      const { code, lines } = await runFor('nobody@example.com')

      expect(code).toBe(ACCOUNT_DELETION_EXIT_UNKNOWN)
      expect(lines).toEqual(['No account has the address nobody@example.com. Nothing was deleted.'])
      expect(await database.db.select().from(users)).toHaveLength(1)
    })
  })
})

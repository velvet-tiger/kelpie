import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ConfigurationError } from '../../lib/config.ts'
import { postgresErrorCode } from '../../lib/database.ts'
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
import { countLockWaits } from '../../testing/lockWaits.ts'
import { createTestServices } from '../../testing/services.ts'
import { activities } from '../activities/schema.ts'
import { apiKeys } from '../api-keys/schema.ts'
import { coreModules } from '../core.ts'
import { enquiries } from '../enquiries/schema.ts'
import { notes } from '../notes/schema.ts'
import { oauthClients, oauthConnections, oauthGrants, oauthTokens } from '../oauth/schema.ts'
import { opportunities } from '../opportunities/schema.ts'
import { rateLimitBuckets } from '../rate-limit/schema.ts'
import { lockMembershipChanges } from '../workspace/repository.ts'
import { idempotencyKeys, workspaceMembers, workspaces } from '../workspace/schema.ts'
import { DELETION_CONTENDED_MESSAGE } from './deletion.ts'
import { SEND_ACCOUNT_DELETED_NOTICE_JOB } from './emailJobs.ts'
import {
  ACCOUNT_DELETION_EXIT_DELETED,
  ACCOUNT_DELETION_EXIT_FAULT,
  ACCOUNT_DELETION_EXIT_REFUSED,
  ACCOUNT_DELETION_EXIT_UNKNOWN,
  ACCOUNT_DELETION_EXIT_USAGE,
  runAccountDeletion,
  runDeleteAccountCommand,
} from './operatorDeletion.ts'
import type { OperatorAssembly } from './operatorDeletion.ts'
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
  /** How many more runs the fixture handler aborts as a Postgres deadlock. */
  let transientFailures: number
  /** When set, the fixture handler fails with it, as a fault rather than a refusal. */
  let fault: Error | undefined

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

        if (transientFailures > 0) {
          transientFailures -= 1

          return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
        }

        if (fault !== undefined) {
          return Promise.reject(fault)
        }

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
    transientFailures = 0
    fault = undefined

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

  /** Waits until the code under test is blocked on a row lock the test holds, or has finished. */
  async function waitForLockWait(settled: () => boolean): Promise<void> {
    await expect
      .poll(async () => settled() || (await countLockWaits(database.db)) > 0, { timeout: 5000 })
      .toBe(true)
  }

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
    return client.send('POST', '/v1/account/delete', { body: { current_password: password }, ...credentials })
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
    it('has no DELETE /v1/account route', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)

      const response = await client.send('DELETE', '/v1/account', { body: { current_password: PASSWORD }, cookie })

      expect([404, 405]).toContain(response.status)
      expect(await accountExists(userId)).toBe(true)
    })

    it('ignores an Idempotency-Key, and stores none for the account it deleted', async () => {
      const grace = await graceInTwoWorkspaces()

      // A key the store already holds for this person, for a different body.
      // A route the middleware guards would answer 409 and not run.
      await database.db.insert(idempotencyKeys).values({
        id: harness.services.createId('idempotencyKey'),
        workspaceId: grace.acme.workspaceId,
        actorKey: `user:${grace.userId}`,
        key: 'retry-1',
        requestHash: 'another request',
        response: { status: 201, body: { id: 'per_1' } },
        expiresAt: new Date('2999-01-01T00:00:00.000Z'),
      })

      const send = (): Promise<Response> =>
        Promise.resolve(
          harness.app.request('/v1/account/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-1', Cookie: grace.cookie },
            body: JSON.stringify({ current_password: PASSWORD }),
          }),
        )

      const first = await send()
      const replay = await send()

      expect(first.status).toBe(204)
      expect(await accountExists(grace.userId)).toBe(false)
      expect(await database.db.select().from(idempotencyKeys)).toEqual([])
      // The session went with the account, so the same key and body now find no one.
      expect(replay.status).toBe(401)
      expect(await database.db.select().from(idempotencyKeys)).toEqual([])
    })

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
        databaseTarget: 'db.example:5432/kelpie_prod',
        email,
        confirmed: true,
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
      expect(lines.at(-1)).toBe(`Deleted account ${grace.userId} (grace@example.com).`)
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
      expect(lines.slice(-2)).toEqual([
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
  describe('the notice to the address', () => {
    async function notices(): Promise<readonly { readonly to: string; readonly body: string }[]> {
      await harness.runQueuedJobs()

      return harness.services.sentEmails
        .filter((message) => message.subject === 'Your Kelpie account was deleted')
        .map((message) => ({ to: message.to, body: message.body }))
    }

    it('sends one notice when the account deletes itself', async () => {
      const grace = await graceInTwoWorkspaces()

      expect((await deleteAccount({ cookie: grace.cookie })).status).toBe(204)
      expect(harness.services.queuedJobs.filter((job) => job.name === SEND_ACCOUNT_DELETED_NOTICE_JOB)).toEqual([
        expect.objectContaining({ data: { email: 'grace@example.com' } }),
      ])

      const sent = await notices()
      expect(sent).toHaveLength(1)
      expect(sent[0]?.to).toBe('grace@example.com')
      expect(sent[0]?.body).toContain('Your Kelpie account for grace@example.com was deleted')
    })

    it('sends nothing to an address that was never verified', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)
      await database.db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, userId))

      expect((await deleteAccount({ cookie })).status).toBe(204)
      expect(harness.services.queuedJobs.filter((job) => job.name === SEND_ACCOUNT_DELETED_NOTICE_JOB)).toEqual([])
      expect(await notices()).toEqual([])
    })

    it('sends nothing when the deletion is refused', async () => {
      const ada = await client.owner('ada@example.com')

      expect((await deleteAccount({ cookie: ada.cookie })).status).toBe(409)
      expect(await notices()).toEqual([])
    })

    it('sends nothing when a later module refuses and the deletion rolls back', async () => {
      const grace = await graceInTwoWorkspaces()
      refusal = AppError.conflict('This account has an open invoice')

      expect((await deleteAccount({ cookie: grace.cookie })).status).toBe(409)
      expect(await notices()).toEqual([])
    })
  })

  describe('when Postgres aborts the deletion', () => {
    it('runs it again after a deadlock, and deletes once', async () => {
      const grace = await graceInTwoWorkspaces()
      await eventsSoFar()
      published = []
      transientFailures = 1

      const response = await deleteAccount({ cookie: grace.cookie })

      expect(response.status).toBe(204)
      expect(handled).toEqual([grace.userId, grace.userId])
      expect(await accountExists(grace.userId)).toBe(false)
      expect((await eventsSoFar()).filter((event) => event.name === 'auth.user.deleted')).toHaveLength(1)
      expect(harness.services.queuedJobs.filter((job) => job.name === SEND_ACCOUNT_DELETED_NOTICE_JOB)).toHaveLength(1)
    })

    it('answers 409 to try again when every run is aborted, and deletes nothing', async () => {
      const grace = await graceInTwoWorkspaces()
      await eventsSoFar()
      published = []
      transientFailures = 3

      const response = await deleteAccount({ cookie: grace.cookie })

      expect(response.status).toBe(409)
      expect(readRecord(await response.json()).error).toMatchObject({ message: DELETION_CONTENDED_MESSAGE })
      expect(handled).toHaveLength(3)
      expect(await accountExists(grace.userId)).toBe(true)
      expect(await eventsSoFar()).toEqual([])
    })

    it('finishes when the member edits a record they own at the same moment', async () => {
      const grace = await graceInTwoWorkspaces()
      const opportunity = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Grant', owner_id: grace.acme.memberId },
        cookie: grace.acme.cookie,
      })
      const opportunityId = readString(await opportunity.json(), 'id')
      let settled = false
      let deleting: Promise<Response> | undefined

      // An edit locks the record, then names the member on its activity. The
      // deletion holds the member row and waits for the record, so Postgres
      // aborts one of the two. Either way the deletion ends deleted.
      await database.db
        .transaction(async (tx) => {
          await tx.update(opportunities).set({ name: 'Grant (edited)' }).where(eq(opportunities.id, opportunityId))
          deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
            settled = true
          })
          await waitForLockWait(() => settled)
          await tx.insert(activities).values({
            id: harness.services.createId('activity'),
            workspaceId: grace.acme.workspaceId,
            targetType: 'opportunity',
            targetId: opportunityId,
            kind: 'updated',
            actorMemberId: grace.acme.memberId,
            action: 'updated Opportunity',
          })
        })
        .catch((error: unknown) => {
          // The edit was the transaction Postgres chose to abort.
          expect(postgresErrorCode(error)).toBe('40P01')
        })

      expect((await (deleting ?? Promise.reject(new Error('never started')))).status).toBe(204)
      expect(await accountExists(grace.userId)).toBe(false)
    })
  })

  describe('with other work in flight', () => {
    it('refuses when the password changes between the check and the row lock', async () => {
      const grace = await graceInTwoWorkspaces()
      let settled = false
      let deleting: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await tx.select().from(users).where(eq(users.id, grace.userId)).for('update')
        deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
        await tx.update(users).set({ passwordHash: 'changed-elsewhere' }).where(eq(users.id, grace.userId))
      })

      const response = await (deleting ?? Promise.reject(new Error('never started')))
      expect(response.status).toBe(401)
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('answers 500 to a handler that fails, rolls back, and publishes nothing', async () => {
      const grace = await graceInTwoWorkspaces()
      const opportunity = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Grant', owner_id: grace.acme.memberId },
        cookie: grace.acme.cookie,
      })
      const opportunityId = readString(await opportunity.json(), 'id')
      await eventsSoFar()
      published = []
      fault = new Error('table missing')

      const response = await deleteAccount({ cookie: grace.cookie })

      expect(response.status).toBe(500)
      expect(await accountExists(grace.userId)).toBe(true)
      const [row] = await database.db.select().from(opportunities).where(eq(opportunities.id, opportunityId))
      expect(row?.ownerId).toBe(grace.acme.memberId)
      expect(await eventsSoFar()).toEqual([])
      expect(harness.logLines.join('\n')).toContain('account-deletion handler of module \\"deletion-fixture\\" failed')
    })

    it('refuses when ownership moves to the account while it is deleted', async () => {
      const grace = await graceInTwoWorkspaces()
      let settled = false
      let deleting: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await lockMembershipChanges(tx, grace.acme.workspaceId)
        await tx
          .update(workspaceMembers)
          .set({ role: 'admin' })
          .where(and(eq(workspaceMembers.workspaceId, grace.acme.workspaceId), eq(workspaceMembers.role, 'owner')))
        await tx.update(workspaceMembers).set({ role: 'owner' }).where(eq(workspaceMembers.id, grace.acme.memberId))
        deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
      })

      const response = await (deleting ?? Promise.reject(new Error('never started')))
      expect(response.status).toBe(409)
      expect(readRecord(await response.json()).error).toMatchObject({
        details: [{ field: grace.acme.workspaceId, message: 'Acme' }],
      })
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('removes a membership that was being added, and publishes its removal', async () => {
      const grace = await graceInTwoWorkspaces()
      const carol = await client.owner('carol@example.com')
      const memberId = harness.services.createId('teamMember')
      await eventsSoFar()
      published = []
      let settled = false
      let deleting: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await tx
          .insert(workspaceMembers)
          .values({ id: memberId, workspaceId: carol.workspaceId, userId: grace.userId, role: 'member' })
        deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
      })

      expect((await (deleting ?? Promise.reject(new Error('never started')))).status).toBe(204)

      const removed = (await eventsSoFar()).filter((event) => event.name === 'workspace.member.removed')
      expect(removed.map((event) => event.workspaceId).toSorted()).toEqual(
        [grace.acme.workspaceId, grace.globex.workspaceId, carol.workspaceId].toSorted(),
      )
    })

    it('clears a record that was being given to the member, and publishes the removal', async () => {
      const grace = await graceInTwoWorkspaces()
      const opportunity = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Grant' },
        cookie: grace.acme.cookie,
      })
      const opportunityId = readString(await opportunity.json(), 'id')
      await eventsSoFar()
      published = []
      let settled = false
      let deleting: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await tx.update(opportunities).set({ ownerId: grace.acme.memberId }).where(eq(opportunities.id, opportunityId))
        deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
      })

      expect((await (deleting ?? Promise.reject(new Error('never started')))).status).toBe(204)

      const [row] = await database.db.select().from(opportunities).where(eq(opportunities.id, opportunityId))
      expect(row?.ownerId).toBeNull()
      expect(
        (await eventsSoFar())
          .filter((event) => event.name === 'workspace.member.removed')
          .map((event) => event.target.id),
      ).toContain(grace.acme.memberId)
    })

    it('finishes the rest when an admin removes the member first', async () => {
      const grace = await graceInTwoWorkspaces()
      await eventsSoFar()
      published = []
      let settled = false
      let deleting: Promise<Response> | undefined

      await database.db.transaction(async (tx) => {
        await lockMembershipChanges(tx, grace.acme.workspaceId)
        await tx.delete(workspaceMembers).where(eq(workspaceMembers.id, grace.acme.memberId))
        deleting = deleteAccount({ cookie: grace.cookie }).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
      })

      expect((await (deleting ?? Promise.reject(new Error('never started')))).status).toBe(204)
      expect(
        (await eventsSoFar())
          .filter((event) => event.name === 'workspace.member.removed')
          .map((event) => event.workspaceId),
      ).toEqual([grace.globex.workspaceId])
    })

    it('deletes two accounts that share two workspaces at the same moment', async () => {
      const acme = await client.owner('ada@example.com')
      const globex = await client.owner('bob@example.com')
      const grace = await client.signUp('grace@example.com')
      const linus = await client.signUp('linus@example.com')

      for (const cookie of [grace, linus]) {
        await join(cookie, globex.workspaceId)
        await join(cookie, acme.workspaceId)
      }

      const [first, second] = await Promise.all([deleteAccount({ cookie: grace }), deleteAccount({ cookie: linus })])

      expect([first?.status, second?.status]).toEqual([204, 204])
      expect(await database.db.select().from(workspaceMembers)).toHaveLength(2)
    })

    it('names both workspaces of an account that owns two', async () => {
      const ada = await client.owner('ada@example.com')
      const second = await client.send('POST', '/v1/workspaces', {
        body: { name: 'Globex', timezone: 'UTC' },
        cookie: ada.cookie,
      })
      const secondId = readString(await second.json(), 'id')

      const response = await deleteAccount({ cookie: ada.cookie })

      expect(response.status).toBe(409)
      expect(
        (readRecord(readRecord(await response.json()).error).details as { field: string; message: string }[]).toSorted(
          (left, right) => left.field.localeCompare(right.field),
        ),
      ).toEqual(
        [
          { field: ada.workspaceId, message: 'Acme' },
          { field: secondId, message: 'Globex' },
        ].toSorted((left, right) => left.field.localeCompare(right.field)),
      )
    })
  })

  describe('what else goes with the account', () => {
    it('deletes the login counter keyed on its address, keeps the mailbox counters, and deletes its idempotency keys', async () => {
      const grace = await graceInTwoWorkspaces()
      // Now, so the prune a request runs does not take the rows first.
      const windowStart = new Date()

      await database.db.insert(rateLimitBuckets).values(
        ['login-account', 'password-reset-account', 'verify-email-address', 'auth'].map((scope) => ({
          id: harness.services.createId('rateLimitBucket'),
          scope,
          key: scope === 'auth' ? '203.0.113.9' : 'grace@example.com',
          windowStart,
        })),
      )
      await database.db.insert(rateLimitBuckets).values({
        id: harness.services.createId('rateLimitBucket'),
        scope: 'login-account',
        key: 'ada@example.com',
        windowStart,
      })
      await database.db.insert(idempotencyKeys).values([
        {
          id: harness.services.createId('idempotencyKey'),
          workspaceId: grace.acme.workspaceId,
          actorKey: `user:${grace.userId}`,
          key: 'grace-key',
          requestHash: 'hash',
          expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        },
        {
          id: harness.services.createId('idempotencyKey'),
          workspaceId: grace.acme.workspaceId,
          actorKey: 'user:usr_someone_else',
          key: 'other-key',
          requestHash: 'hash',
          expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        },
      ])

      expect((await deleteAccount({ cookie: grace.cookie })).status).toBe(204)

      const buckets = await database.db
        .select({ scope: rateLimitBuckets.scope, key: rateLimitBuckets.key })
        .from(rateLimitBuckets)
        .where(inArray(rateLimitBuckets.key, ['grace@example.com', 'ada@example.com', '203.0.113.9']))
      expect(
        buckets.toSorted((left, right) => `${left.key}:${left.scope}`.localeCompare(`${right.key}:${right.scope}`)),
      ).toEqual([
        { scope: 'auth', key: '203.0.113.9' },
        { scope: 'login-account', key: 'ada@example.com' },
        { scope: 'password-reset-account', key: 'grace@example.com' },
        { scope: 'verify-email-address', key: 'grace@example.com' },
      ])
      expect((await database.db.select().from(idempotencyKeys)).map((row) => row.key)).toEqual(['other-key'])
    })

    it('deletes the idempotency keys written through its personal API key and its OAuth connection', async () => {
      const grace = await graceInTwoWorkspaces()
      const personalKey = await mintKey(grace.cookie, 'personal')
      await connectApp(grace.userId, grace.acme.workspaceId)

      const created = await client.send('POST', '/v1/people', { body: { name: 'Linus Torvalds' }, bearer: personalKey })
      expect(created.status).toBe(201)
      const viaKey = await harness.app.request('/v1/people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${personalKey}`, 'Idempotency-Key': 'via-key' },
        body: JSON.stringify({ name: 'Margaret Hamilton' }),
      })
      expect(viaKey.status).toBe(201)

      const stored = await database.db.select().from(idempotencyKeys)
      expect(stored.map((row) => row.actorKey)).toEqual([expect.stringMatching(/^api_key:/u)])

      await database.db.insert(idempotencyKeys).values(
        ['oauth:ocn_test', 'oauth_connection:ocn_test', 'api_key:key_someone_else'].map((actorKey) => ({
          id: harness.services.createId('idempotencyKey'),
          workspaceId: grace.acme.workspaceId,
          actorKey,
          key: actorKey,
          requestHash: 'hash',
          expiresAt: new Date('2999-01-01T00:00:00.000Z'),
        })),
      )

      expect((await deleteAccount({ cookie: grace.cookie })).status).toBe(204)

      expect((await database.db.select().from(idempotencyKeys)).map((row) => row.actorKey)).toEqual(['api_key:key_someone_else'])
    })
  })

  describe('the operator command', () => {
    const DATABASE_URL = 'postgres://kelpie:not-for-the-terminal@db.example:5432/kelpie_prod'

    interface Run {
      readonly code: number
      readonly out: readonly string[]
      readonly err: readonly string[]
    }

    async function command(
      argv: readonly string[],
      overrides: Partial<OperatorAssembly> = {},
      boot?: () => Promise<OperatorAssembly>,
    ): Promise<Run> {
      const out: string[] = []
      const err: string[] = []
      const assembly: OperatorAssembly = {
        db: database.db,
        databaseUrl: DATABASE_URL,
        transaction: harness.services.transaction,
        runAccountDeletionHandlers: harness.contributions.runAccountDeletionHandlers,
        startJobs: () => Promise.resolve(),
        drainEvents: () => harness.services.events.drain(),
        stopJobs: () => Promise.resolve(),
        closeDatabase: () => Promise.resolve(),
        ...overrides,
      }
      const code = await runDeleteAccountCommand({
        argv,
        boot: boot ?? (() => Promise.resolve(assembly)),
        configurationHint: 'Fix the configuration.',
        report: (line) => out.push(line),
        reportFatal: (line) => err.push(line),
      })

      return { code, out, err }
    }

    it('prints the target and deletes nothing without --yes', async () => {
      const grace = await graceInTwoWorkspaces()

      const run = await command(['grace@example.com'])

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_USAGE)
      expect(run.out[0]).toBe('Database: db.example:5432/kelpie_prod')
      expect(run.out[1]).toBe(`Account: ${grace.userId} grace@example.com`)
      expect(run.out).toContain(`  ${grace.acme.workspaceId} Acme (member)`)
      expect(run.out).toContain(`  ${grace.globex.workspaceId} Acme (member)`)
      expect(run.out.at(-1)).toBe('Nothing was deleted. Run the same command with --yes to delete this account.')
      expect([...run.out, ...run.err].join('\n')).not.toContain('not-for-the-terminal')
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('prints the target and deletes with --yes', async () => {
      const grace = await graceInTwoWorkspaces()

      const run = await command(['--yes', 'Grace@Example.com'])

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_DELETED)
      expect(run.out[0]).toBe('Database: db.example:5432/kelpie_prod')
      expect(run.out.at(-1)).toBe(`Deleted account ${grace.userId} (grace@example.com).`)
      expect(await accountExists(grace.userId)).toBe(false)
    })

    it('treats an empty address, a second address and an unknown flag as usage errors', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)

      for (const argv of [[], ['   '], ['a@example.com', 'b@example.com'], ['grace@example.com', '--force']]) {
        const run = await command(argv)

        expect(run.code).toBe(ACCOUNT_DELETION_EXIT_USAGE)
        expect(run.err).toEqual(['Usage: npm run delete-account -- <email> [--yes]'])
      }

      expect(await accountExists(userId)).toBe(true)
    })

    it('answers 4 with one line to a fault, and still cleans up', async () => {
      const cookie = await client.signUp('grace@example.com')
      const userId = await accountIdOf(cookie)
      const steps: string[] = []

      const run = await command(['grace@example.com', '--yes'], {
        startJobs: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432\n    at stack frame')),
        drainEvents: () => {
          steps.push('drain')
          return Promise.resolve()
        },
        stopJobs: () => {
          steps.push('stop')
          return Promise.resolve()
        },
        closeDatabase: () => {
          steps.push('close')
          return Promise.resolve()
        },
      })

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_FAULT)
      expect(run.err).toEqual(['Failed: Error: connect ECONNREFUSED 127.0.0.1:5432. Nothing was deleted.'])
      expect(steps).toEqual(['drain', 'stop', 'close'])
      expect(await accountExists(userId)).toBe(true)
    })

    it('answers 4 when every run of the deletion collides with other work', async () => {
      const grace = await graceInTwoWorkspaces()
      transientFailures = 3

      const run = await command(['grace@example.com', '--yes'])

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_FAULT)
      expect(run.err).toEqual([`Failed: ${DELETION_CONTENDED_MESSAGE}. Nothing was deleted.`])
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('answers 4 to a handler that fails', async () => {
      const grace = await graceInTwoWorkspaces()
      fault = new Error('table missing')

      const run = await command(['grace@example.com', '--yes'])

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_FAULT)
      expect(run.err).toEqual([
        'Failed: Error: account-deletion handler of module "deletion-fixture" failed: Error: table missing. Nothing was deleted.',
      ])
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('reports a clean-up that fails and keeps the deletion result', async () => {
      const grace = await graceInTwoWorkspaces()

      const run = await command(['grace@example.com', '--yes'], {
        stopJobs: () => Promise.reject(new Error('boss would not stop')),
        closeDatabase: () => Promise.reject(new Error('pool already ended')),
      })

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_DELETED)
      expect(run.err).toEqual([
        'Clean-up failed while stopping the job runtime: Error: boss would not stop',
        'Clean-up failed while closing the database: Error: pool already ended',
      ])
      expect(await accountExists(grace.userId)).toBe(false)
    })

    it('answers 1 with the problems and the hint when the configuration will not boot', async () => {
      const run = await command(['grace@example.com', '--yes'], {}, () =>
        Promise.reject(new ConfigurationError(['DATABASE_URL: Required'])),
      )

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_USAGE)
      expect(run.err).toEqual(['Invalid environment configuration:', '  - DATABASE_URL: Required', 'Fix the configuration.'])
    })

    it('escapes terminal control characters in everything it prints', async () => {
      const ada = await client.owner('ada@example.com')
      await database.db
        .update(workspaces)
        .set({ name: `Evil\u001b]0;owned\u0007\u001b[2J${String.fromCodePoint(0x2028)}Co${String.fromCodePoint(0x202e)}gpj.exe` })
        .where(eq(workspaces.id, ada.workspaceId))

      const run = await command(['ada@example.com', '--yes'])
      const printed = [...run.out, ...run.err].join('\n')

      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_REFUSED)
      expect(printed).toContain('Evil\\u001b]0;owned\\u0007\\u001b[2J\\u2028Co\\u202egpj.exe')
      // eslint-disable-next-line no-control-regex -- the assertion is that none is left
      expect(printed).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u)
      expect(run.err).toContain(`  ${ada.workspaceId}: Evil\\u001b]0;owned\\u0007\\u001b[2J\\u2028Co\\u202egpj.exe`)
    })

    it('refuses with 2 when the account moves off the address between the lookup and the lock', async () => {
      const grace = await graceInTwoWorkspaces()
      let settled = false
      let running: Promise<Run> | undefined

      await database.db.transaction(async (tx) => {
        await tx.select().from(users).where(eq(users.id, grace.userId)).for('update')
        running = command(['grace@example.com', '--yes']).finally(() => {
          settled = true
        })
        await waitForLockWait(() => settled)
        await tx.update(users).set({ email: 'grace.new@example.com' }).where(eq(users.id, grace.userId))
      })

      const run = await (running ?? Promise.reject(new Error('never started')))
      expect(run.code).toBe(ACCOUNT_DELETION_EXIT_UNKNOWN)
      expect(run.err.at(-1)).toBe(
        `The account ${grace.userId} moved off the address grace@example.com while this ran. Nothing was deleted.`,
      )
      expect(await accountExists(grace.userId)).toBe(true)
    })

    it('sends the notice when an operator deletes the account', async () => {
      await graceInTwoWorkspaces()

      expect((await command(['grace@example.com', '--yes'])).code).toBe(ACCOUNT_DELETION_EXIT_DELETED)

      await harness.runQueuedJobs()
      expect(
        harness.services.sentEmails.filter((message) => message.subject === 'Your Kelpie account was deleted'),
      ).toHaveLength(1)
    })
  })

})

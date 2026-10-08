import { decisionSchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { asAiAuthor, createHostedAiActor } from '../../lib/actor.ts'
import type { OAuthActor, SessionActor } from '../../lib/actor.ts'
import { AppError } from '../../lib/errors.ts'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { decisions } from './schema.ts'
import { createDecisionsService } from './service.ts'

/**
 * `/v1/decisions` against real Postgres. Decisions attach to any CRM record and,
 * unlike notes, also answer one workspace-wide list.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('decisions', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let personId: string

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  function addDecision(body: Record<string, unknown>, cookie = acme.cookie): Promise<Response> {
    return client.send('POST', '/v1/decisions', { body, cookie })
  }

  async function decisionOn(
    targetId: string,
    body: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await addDecision({
      target_type: 'person',
      target_id: targetId,
      body,
      ...extra,
    })

    return readRecord(await response.json())
  }

  async function mintKey(kind: 'workspace' | 'personal'): Promise<string> {
    const response = await client.send('POST', '/v1/api-keys', {
      body: { name: 'agent', kind },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readString(await response.json(), 'secret')
  }

  function listDecisions(query = '', cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/decisions${query === '' ? '' : `?${query}`}`, { cookie })
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
    personId = await createPerson('Ada Lovelace')
  })

  describe('creating', () => {
    it('records a decision with the caller as owner and now as the moment', async () => {
      const response = await addDecision({
        target_type: 'person',
        target_id: personId,
        body: 'We will not build a favour ledger.',
      })
      const decision = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(decision.id).toMatch(/^dec_/u)
      expect(decision.target_type).toBe('person')
      expect(decision.target_id).toBe(personId)
      expect(decision.body).toBe('We will not build a favour ledger.')
      expect(decision.rationale).toBeNull()
      expect(decision.owner_id).toMatch(/^mem_/u)
      expect(decision.due_at).toBeNull()
      expect(new Date(readString(decision, 'decided_at')).toISOString()).toBe(decision.decided_at)
    })

    it('accepts the full field set', async () => {
      const owner = await decisionOn(personId, 'Seed')
      const response = await addDecision({
        target_type: 'person',
        target_id: personId,
        body: 'Ship the panel first.',
        rationale: 'The list page has no data without it.',
        decided_at: '2026-07-01T09:30:00.000Z',
        owner_id: owner.owner_id,
        due_at: '2026-09-01T00:00:00.000Z',
      })
      const decision = readRecord(await response.json())

      expect(decision.rationale).toBe('The list page has no data without it.')
      expect(decision.decided_at).toBe('2026-07-01T09:30:00.000Z')
      expect(decision.owner_id).toBe(owner.owner_id)
      expect(decision.due_at).toBe('2026-09-01T00:00:00.000Z')
    })

    it('reads an explicit null owner as nobody, not the caller', async () => {
      const decision = await decisionOn(personId, 'Unowned', { owner_id: null })

      expect(decision.owner_id).toBeNull()
    })

    it('answers 404 for a target that does not exist', async () => {
      const response = await addDecision({
        target_type: 'person',
        target_id: 'per_nope',
        body: 'Into the void.',
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for a target in another workspace', async () => {
      const other = await client.owner('grace@example.com')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      expect(
        (await addDecision({ target_type: 'person', target_id: theirs, body: 'Peek' })).status,
      ).toBe(404)
    })

    it('answers 404 for an owner that is not on this team', async () => {
      const other = await client.owner('grace@example.com')
      const theirPerson = await createPerson('Grace Hopper', other.cookie)
      const theirDecision = readRecord(
        await (
          await addDecision(
            { target_type: 'person', target_id: theirPerson, body: 'Theirs' },
            other.cookie,
          )
        ).json(),
      )

      const unknown = await addDecision({
        target_type: 'person',
        target_id: personId,
        body: 'x',
        owner_id: 'mem_nope',
      })
      const foreign = await addDecision({
        target_type: 'person',
        target_id: personId,
        body: 'x',
        owner_id: theirDecision.owner_id,
      })

      expect(unknown.status).toBe(404)
      expect(foreign.status).toBe(404)
    })

    it('answers 422 for an empty body, an unknown target type, an unknown field, and a malformed moment', async () => {
      const target = { target_type: 'person', target_id: personId }

      expect((await addDecision({ ...target, body: '' })).status).toBe(422)
      expect((await addDecision({ target_type: 'role', target_id: personId, body: 'x' })).status).toBe(422)
      expect((await addDecision({ ...target, body: 'x', ownr: 'me' })).status).toBe(422)
      expect((await addDecision({ ...target, body: 'x', decided_at: 'yesterday' })).status).toBe(422)
      expect((await addDecision({ ...target, body: 'x', rationale: '' })).status).toBe(422)
    })

    it('answers 401 without credentials', async () => {
      const response = await client.send('POST', '/v1/decisions', {
        body: { target_type: 'person', target_id: personId, body: 'x' },
      })

      expect(response.status).toBe(401)
    })
  })

  describe('listing', () => {
    it('answers the workspace list, most recently decided first', async () => {
      await decisionOn(personId, 'Older', { decided_at: '2026-06-01T00:00:00.000Z' })
      await decisionOn(personId, 'Newer', { decided_at: '2026-07-01T00:00:00.000Z' })

      const decisions = readList(await (await listDecisions()).json())

      expect(decisions.map((decision) => decision.body)).toEqual(['Newer', 'Older'])
    })

    it('filters on target type and a set of target ids', async () => {
      const companyResponse = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines' },
        cookie: acme.cookie,
      })
      const companyId = readString(await companyResponse.json(), 'id')
      const secondPerson = await createPerson('Grace Hopper')

      await decisionOn(personId, 'On Ada')
      await decisionOn(secondPerson, 'On Grace')
      await addDecision({ target_type: 'company', target_id: companyId, body: 'On the company' })

      const people = readList(await (await listDecisions('target_type=person')).json())
      const both = readList(
        await (await listDecisions(`target_id=${personId}&target_id=${companyId}`)).json(),
      )

      expect(people.map((decision) => decision.body).sort()).toEqual(['On Ada', 'On Grace'])
      expect(both.map((decision) => decision.body).sort()).toEqual(['On Ada', 'On the company'])
    })

    it('matches ?q= against the body, the rationale, and the target name', async () => {
      await decisionOn(personId, 'Ship the panel first.', {
        rationale: 'The list page has no data without it.',
      })

      async function bodiesFor(term: string): Promise<unknown[]> {
        const listed = readList(await (await listDecisions(`q=${term}`)).json())

        return listed.map((decision) => decision.body)
      }

      expect(await bodiesFor('panel')).toHaveLength(1)
      expect(await bodiesFor('without')).toHaveLength(1)
      expect(await bodiesFor('Lovelace')).toHaveLength(1)
      expect(await bodiesFor('nothinghere')).toHaveLength(0)
    })

    it('answers 422 for a target type nothing attaches a decision to', async () => {
      expect((await listDecisions('target_type=role')).status).toBe(422)
    })

    it('does not leak another workspace into the list', async () => {
      const other = await client.owner('grace@example.com')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      await addDecision({ target_type: 'person', target_id: theirs, body: 'Theirs' }, other.cookie)
      await decisionOn(personId, 'Ours')

      const decisions = readList(await (await listDecisions()).json())

      expect(decisions.map((decision) => decision.body)).toEqual(['Ours'])
    })
  })

  describe('reading and editing one', () => {
    it('reads a decision back by id', async () => {
      const created = await decisionOn(personId, 'Body')
      const response = await client.send('GET', `/v1/decisions/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).body).toBe('Body')
    })

    it('edits the fields and clears the nullable ones', async () => {
      const created = await decisionOn(personId, 'Before', {
        rationale: 'Old reasoning.',
        due_at: '2026-09-01T00:00:00.000Z',
      })
      const response = await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
        body: {
          body: 'After',
          rationale: null,
          decided_at: '2026-07-15T00:00:00.000Z',
          owner_id: null,
          due_at: null,
        },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(updated.body).toBe('After')
      expect(updated.rationale).toBeNull()
      expect(updated.decided_at).toBe('2026-07-15T00:00:00.000Z')
      expect(updated.owner_id).toBeNull()
      expect(updated.due_at).toBeNull()
    })

    it('refuses an owner from outside the team', async () => {
      const other = await client.owner('grace@example.com')
      const theirPerson = await createPerson('Grace Hopper', other.cookie)
      const theirDecision = readRecord(
        await (
          await addDecision(
            { target_type: 'person', target_id: theirPerson, body: 'Theirs' },
            other.cookie,
          )
        ).json(),
      )
      const created = await decisionOn(personId, 'Body')

      const response = await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
        body: { owner_id: theirDecision.owner_id },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('leaves updated_at alone for a PATCH that changes nothing', async () => {
      const created = await decisionOn(personId, 'Same')
      const response = await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
        body: { body: 'Same' },
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).updated_at).toBe(created.updated_at)
    })

    it('refuses to re-file a decision under another record', async () => {
      const created = await decisionOn(personId, 'Body')
      const response = await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
        body: { target_id: 'per_other' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('answers 404 across a workspace boundary', async () => {
      const created = await decisionOn(personId, 'Body')
      const other = await client.owner('grace@example.com')

      expect(
        (await client.send('GET', `/v1/decisions/${String(created.id)}`, { cookie: other.cookie }))
          .status,
      ).toBe(404)
      expect(
        (
          await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
            body: { body: 'Theirs now' },
            cookie: other.cookie,
          })
        ).status,
      ).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the decision and answers 204', async () => {
      const created = await decisionOn(personId, 'Body')
      const response = await client.send('DELETE', `/v1/decisions/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)
      expect(readList(await (await listDecisions()).json())).toHaveLength(0)
    })

    it('answers 404 across a workspace boundary', async () => {
      const created = await decisionOn(personId, 'Body')
      const other = await client.owner('grace@example.com')

      expect(
        (
          await client.send('DELETE', `/v1/decisions/${String(created.id)}`, {
            cookie: other.cookie,
          })
        ).status,
      ).toBe(404)
    })
  })

  describe('origin', () => {
    it('is member for a decision a signed-in member records', async () => {
      const created = await decisionOn(personId, 'Body')

      expect(created.origin).toBe('member')
    })

    it('is agent for a decision an API key records, workspace or personal', async () => {
      for (const kind of ['workspace', 'personal'] as const) {
        const response = await client.send('POST', '/v1/decisions', {
          body: { target_type: 'person', target_id: personId, body: `From a ${kind} key` },
          bearer: await mintKey(kind),
        })

        expect(response.status).toBe(201)
        expect(readRecord(await response.json()).origin).toBe('agent')
      }
    })

    it('refuses a create that sends origin', async () => {
      const response = await addDecision({
        target_type: 'person',
        target_id: personId,
        body: 'Body',
        origin: 'member',
      })

      expect(response.status).toBe(422)
    })

    it('refuses an update that sends origin, with a session or a key', async () => {
      const created = await decisionOn(personId, 'Body')
      const path = `/v1/decisions/${String(created.id)}`

      expect(
        (await client.send('PATCH', path, { body: { origin: 'ai' }, cookie: acme.cookie })).status,
      ).toBe(422)
      expect(
        (await client.send('PATCH', path, { body: { origin: 'ai' }, bearer: await mintKey('workspace') })).status,
      ).toBe(422)
    })

    /** A decision as an older writer or a model left it, which no REST caller can make. */
    async function storedDecision(origin: 'ai' | 'unknown', confirmedAt: Date | null): Promise<string> {
      const id = harness.services.createId('decision')

      await database.db.insert(decisions).values({
        id,
        workspaceId: acme.workspaceId,
        targetType: 'person',
        targetId: personId,
        body: `Stored with origin ${origin}`,
        origin,
        confirmedAt,
        confirmedById: null,
      })

      return id
    }

    async function patch(
      id: string,
      body: Record<string, unknown>,
      credentials: { cookie?: string; bearer?: string },
    ): Promise<Record<string, unknown>> {
      const response = await client.send('PATCH', `/v1/decisions/${id}`, { body, ...credentials })

      expect(response.status).toBe(200)

      return readRecord(await response.json())
    }

    /** `decisions_update` over `/mcp`, as an agent with this key calls it. */
    async function updateOverMcp(key: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'decisions_update', arguments: args },
        }),
      })
      const result = readRecord(readRecord(await response.json()).result)
      const [content] = result.content as { text: string }[]

      expect(result.isError).not.toBe(true)

      return readRecord(JSON.parse(content?.text ?? 'null'))
    }

    it('does not make an agent decision a member decision when a member edits it', async () => {
      const byKey = readRecord(
        await (
          await client.send('POST', '/v1/decisions', {
            body: { target_type: 'person', target_id: personId, body: 'From a key' },
            bearer: await mintKey('workspace'),
          })
        ).json(),
      )

      const edited = await patch(String(byKey.id), { body: 'Edited by a member' }, { cookie: acme.cookie })

      expect(edited.origin).toBe('agent')
      expect(edited.confirmed_by_id).toBeNull()
    })

    it('takes the member off a decision when an API key rewrites its body or its rationale', async () => {
      const key = await mintKey('personal')

      for (const change of [{ body: 'Rewritten by a key' }, { rationale: 'A reason a key wrote' }]) {
        const created = await decisionOn(personId, 'From a member')

        expect(created.confirmed_by_id).toMatch(/^mem_/u)

        const edited = await patch(String(created.id), change, { bearer: key })

        expect(edited.origin).toBe('agent')
        expect(edited.confirmed_by_id).toBeNull()
        // It was a commitment before the edit and no edit changes that, in either direction.
        expect(edited.confirmed_at).toBe(created.confirmed_at)
      }
    })

    it('takes the member off a decision when an agent rewrites its body over MCP', async () => {
      const created = await decisionOn(personId, 'From a member')

      const edited = await updateOverMcp(await mintKey('workspace'), { id: created.id, body: 'Rewritten over MCP' })

      expect(edited.origin).toBe('agent')
      expect(edited.confirmed_by_id).toBeNull()
    })

    it('keeps the origin and the member when an API key changes only the date, the owner, or nothing', async () => {
      const created = await decisionOn(personId, 'From a member')
      const key = await mintKey('workspace')

      for (const change of [
        { due_at: '2026-09-01T00:00:00.000Z' },
        { owner_id: null },
        { decided_at: '2026-07-01T09:30:00.000Z' },
        { body: 'From a member' },
      ]) {
        const edited = await patch(String(created.id), change, { bearer: key })

        expect(edited.origin).toBe('member')
        expect(edited.confirmed_by_id).toBe(created.confirmed_by_id)
      }

      const overMcp = await updateOverMcp(key, { id: created.id, due_at: null })

      expect(overMcp.origin).toBe('member')
      expect(overMcp.confirmed_by_id).toBe(created.confirmed_by_id)
    })

    it('keeps a member decision as it is when a member edits it', async () => {
      const created = await decisionOn(personId, 'From a member')

      const edited = await patch(String(created.id), { body: 'Edited by the member' }, { cookie: acme.cookie })

      expect(edited.origin).toBe('member')
      expect(edited.confirmed_by_id).toBe(created.confirmed_by_id)
    })

    it('keeps a model decision as ai and unconfirmed, whoever rewrites it', async () => {
      const id = await storedDecision('ai', null)

      const byKey = await patch(id, { body: 'Rewritten by a key' }, { bearer: await mintKey('workspace') })
      const overMcp = await updateOverMcp(await mintKey('workspace'), { id, rationale: 'Rewritten over MCP' })
      const byMember = await patch(id, { body: 'Rewritten by a member' }, { cookie: acme.cookie })

      for (const edited of [byKey, overMcp, byMember]) {
        expect(edited.origin).toBe('ai')
        expect(edited.confirmed_at).toBeNull()
        expect(edited.confirmed_by_id).toBeNull()
      }
    })

    it('makes a decision from before origin was recorded an agent decision when a key rewrites it, and leaves it for a member', async () => {
      const byMember = await storedDecision('unknown', new Date('2026-01-02T03:04:05.000Z'))
      const byKey = await storedDecision('unknown', new Date('2026-01-02T03:04:05.000Z'))

      expect((await patch(byMember, { body: 'Rewritten by a member' }, { cookie: acme.cookie })).origin).toBe('unknown')

      const edited = await patch(byKey, { body: 'Rewritten by a key' }, { bearer: await mintKey('workspace') })

      expect(edited.origin).toBe('agent')
      expect(edited.confirmed_at).toBe('2026-01-02T03:04:05.000Z')
    })

  })

  describe('confirming', () => {
    /**
     * A decision as a hosted AI run leaves it. Written to the table because
     * core has no caller that makes one: the `ai` module is not in
     * `coreModules`, and its own suite covers the run that writes this row.
     */
    async function proposal(workspaceId = acme.workspaceId, targetId = personId): Promise<string> {
      const id = harness.services.createId('decision')

      await database.db.insert(decisions).values({
        id,
        workspaceId,
        targetType: 'person',
        targetId,
        body: 'Proposed by a run',
        origin: 'ai',
        confirmedAt: null,
        confirmedById: null,
      })

      return id
    }

    function confirm(id: string, credentials: { cookie?: string; bearer?: string }): Promise<Response> {
      return client.send('POST', `/v1/decisions/${id}/confirm`, credentials)
    }

    async function read(id: string): Promise<Record<string, unknown>> {
      return readRecord(await (await client.send('GET', `/v1/decisions/${id}`, { cookie: acme.cookie })).json())
    }

    it('confirms a decision a member records as it is written, naming the member', async () => {
      const created = await decisionOn(personId, 'Body')

      expect(created.confirmed_at).toBe(created.decided_at)
      expect(created.confirmed_by_id).toBe(created.owner_id)
    })

    it('confirms a decision an API key records as it is written, naming nobody', async () => {
      const response = await client.send('POST', '/v1/decisions', {
        body: { target_type: 'person', target_id: personId, body: 'From a key' },
        bearer: await mintKey('personal'),
      })
      const created = readRecord(await response.json())

      expect(created.confirmed_at).toBe(created.decided_at)
      expect(created.confirmed_by_id).toBeNull()
    })

    it('lets a signed-in member confirm a proposal, and records who and when', async () => {
      const id = await proposal()

      expect((await read(id)).confirmed_at).toBeNull()

      const response = await confirm(id, { cookie: acme.cookie })
      const confirmed = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(new Date(readString(confirmed, 'confirmed_at')).toISOString()).toBe(confirmed.confirmed_at)
      expect(confirmed.confirmed_by_id).toMatch(/^mem_/u)
      // Confirming says who checked it. It does not rewrite what wrote it.
      expect(confirmed.origin).toBe('ai')
      expect(decisionSchema.parse(confirmed).confirmedAt).toBeInstanceOf(Date)
    })

    it('changes nothing on a second confirm, also by another member', async () => {
      const id = await proposal()
      const first = readRecord(await (await confirm(id, { cookie: acme.cookie })).json())

      const again = await confirm(id, { cookie: acme.cookie })

      expect(again.status).toBe(200)
      expect(readRecord(await again.json())).toEqual(first)

      const [stored] = await database.db.select().from(decisions).where(eq(decisions.id, id))

      expect(stored?.confirmedAt?.toISOString()).toBe(first.confirmed_at)
      expect(stored?.updatedAt.toISOString()).toBe(first.updated_at)
    })

    it('changes nothing when a member confirms a decision that was confirmed as it was written', async () => {
      const created = await decisionOn(personId, 'Body')
      const response = await confirm(String(created.id), { cookie: acme.cookie })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json())).toEqual(created)
    })

    it('answers 403 to an API key, workspace or personal, and leaves the proposal as it was', async () => {
      const id = await proposal()

      for (const kind of ['workspace', 'personal'] as const) {
        const response = await confirm(id, { bearer: await mintKey(kind) })

        expect(response.status).toBe(403)
      }

      expect((await read(id)).confirmed_at).toBeNull()
    })

    it('answers 403 to an API key for an id that does not exist, the same as for one that does', async () => {
      const response = await confirm('dec_01M1DDZFG3N7TWB3F3X4AV4S96', { bearer: await mintKey('workspace') })

      expect(response.status).toBe(403)
    })

    it('answers 401 to no credential', async () => {
      expect((await confirm(await proposal(), {})).status).toBe(401)
    })

    /**
     * No HTTP door leads an OAuth token or the hosted AI here: `/v1` answers
     * `401` to an OAuth token, and there is no confirm tool on `/mcp`. The
     * service must still refuse them, so that a door added later does not
     * open this.
     */
    it('refuses an OAuth actor, the hosted AI actor and a session marked as a model at the service', async () => {
      const id = await proposal()
      const service = createDecisionsService({
        db: harness.services.db,
        transaction: harness.services.transaction,
        createId: harness.services.createId,
        now: harness.services.now,
      })
      const oauth: OAuthActor = {
        kind: 'oauth',
        grantId: 'ogr_test',
        connectionId: 'ocn_test',
        clientId: 'client',
        userId: 'usr_test',
        workspaceId: acme.workspaceId,
        role: 'owner',
        scopes: ['decisions:write'],
        memberId: 'mem_test',
      }

      const member: SessionActor = {
        kind: 'session',
        userId: 'usr_test',
        sessionId: 'ses_test',
        workspaceId: acme.workspaceId,
        role: 'owner',
        memberId: 'mem_test',
      }

      // The last is a member's session marked for one write of a model's text,
      // as person intake makes. It must not confirm either.
      for (const actor of [oauth, createHostedAiActor(acme.workspaceId), asAiAuthor(member)]) {
        const refusal: unknown = await service
          .confirm(actor, id, { updatedAt: undefined })
          .catch((thrown: unknown) => thrown)

        expect(refusal).toBeInstanceOf(AppError)
        expect(refusal instanceof AppError && refusal.code).toBe('forbidden')
      }

      expect((await read(id)).confirmed_at).toBeNull()
    })

    describe('with the version the member read', () => {
      function confirmVersion(id: string, updatedAt: unknown): Promise<Response> {
        return client.send('POST', `/v1/decisions/${id}/confirm`, {
          body: { updated_at: updatedAt },
          cookie: acme.cookie,
        })
      }

      it('confirms when the proposal is the one the member read', async () => {
        const id = await proposal()
        const shown = await read(id)
        const response = await confirmVersion(id, shown.updated_at)

        expect(response.status).toBe(200)
        expect(readRecord(await response.json()).confirmed_at).not.toBeNull()
      })

      /** The swap: an agent rewrites the proposal between the member's read and the click. */
      it('answers 409 and confirms nothing when an API key edited the proposal after the read', async () => {
        const id = await proposal()
        const shown = await read(id)

        // A later millisecond, as any real edit after a read is.
        await new Promise((resolve) => setTimeout(resolve, 5))
        await client.send('PATCH', `/v1/decisions/${id}`, {
          body: { body: 'We give Acme 90% off for life.' },
          bearer: await mintKey('workspace'),
        })

        const response = await confirmVersion(id, shown.updated_at)

        expect(response.status).toBe(409)

        const after = await read(id)

        expect(after.confirmed_at).toBeNull()
        expect(after.confirmed_by_id).toBeNull()
        // The member reads the new text and can then confirm that.
        expect((await confirmVersion(id, after.updated_at)).status).toBe(200)
      })

      it('stays safe to repeat: a retry with the version from before the confirm answers 200', async () => {
        const id = await proposal()
        const shown = await read(id)
        const first = readRecord(await (await confirmVersion(id, shown.updated_at)).json())
        const retry = await confirmVersion(id, shown.updated_at)

        expect(retry.status).toBe(200)
        expect(readRecord(await retry.json())).toEqual(first)
      })

      it('answers 422 to a version that is not a time, or to another field', async () => {
        const id = await proposal()

        expect((await confirmVersion(id, 'yesterday')).status).toBe(422)
        expect(
          (
            await client.send('POST', `/v1/decisions/${id}/confirm`, {
              body: { confirmed_by_id: 'mem_test' },
              cookie: acme.cookie,
            })
          ).status,
        ).toBe(422)
        expect((await read(id)).confirmed_at).toBeNull()
      })
    })

    describe('events', () => {
      interface Seen {
        readonly name: string
        readonly target: unknown
        readonly data: unknown
      }

      function watch(): Seen[] {
        const seen: Seen[] = []

        harness.services.events.subscribe('decisions.decision.added', (event) => {
          seen.push({ name: event.name, target: event.target, data: event.data })
        })
        harness.services.events.subscribe('decisions.decision.confirmed', (event) => {
          seen.push({ name: event.name, target: event.target, data: event.data })
        })

        return seen
      }

      it('says on decision.added that a member decision is confirmed, and emits no confirmed event for it', async () => {
        const seen = watch()
        const created = await decisionOn(personId, 'Body')

        await harness.services.events.drain()

        expect(seen).toEqual([
          {
            name: 'decisions.decision.added',
            target: { type: 'person', id: personId },
            data: { decisionId: created.id, origin: 'member', confirmed: true },
          },
        ])
      })

      it('emits decision.confirmed once when a member confirms a proposal, and not on a second confirm', async () => {
        const id = await proposal()
        const seen = watch()

        await confirm(id, { cookie: acme.cookie })
        await confirm(id, { cookie: acme.cookie })
        await confirm(id, { bearer: await mintKey('workspace') })
        await harness.services.events.drain()

        expect(seen).toEqual([
          {
            name: 'decisions.decision.confirmed',
            target: { type: 'person', id: personId },
            data: { decisionId: id, origin: 'ai' },
          },
        ])
      })
    })

    it('answers 404 across a workspace boundary, and confirms nothing', async () => {
      const id = await proposal()
      const other = await client.owner('grace@example.com')

      expect((await confirm(id, { cookie: other.cookie })).status).toBe(404)
      expect((await read(id)).confirmed_at).toBeNull()
    })

    it('does not confirm a proposal when an API key or a member edits it', async () => {
      const id = await proposal()
      const byKey = await client.send('PATCH', `/v1/decisions/${id}`, {
        body: { body: 'Edited by a key', owner_id: null },
        bearer: await mintKey('workspace'),
      })
      const byMember = await client.send('PATCH', `/v1/decisions/${id}`, {
        body: { rationale: 'Edited by a member' },
        cookie: acme.cookie,
      })

      expect(byKey.status).toBe(200)
      expect(readRecord(await byKey.json()).confirmed_at).toBeNull()
      expect(byMember.status).toBe(200)
      expect(readRecord(await byMember.json()).confirmed_at).toBeNull()
    })

    it('refuses a create or an update that sends confirmed_at or confirmed_by_id', async () => {
      const id = await proposal()
      const now = '2026-07-01T09:30:00.000Z'

      for (const field of [{ confirmed_at: now }, { confirmed_by_id: 'mem_test' }]) {
        const created = await addDecision({ target_type: 'person', target_id: personId, body: 'Body', ...field })
        const patched = await client.send('PATCH', `/v1/decisions/${id}`, {
          body: field,
          bearer: await mintKey('workspace'),
        })

        expect(created.status).toBe(422)
        expect(patched.status).toBe(422)
      }

      expect((await read(id)).confirmed_at).toBeNull()
    })

    it('filters the list on ?confirmed=', async () => {
      const proposed = await proposal()
      const committed = await decisionOn(personId, 'A commitment')
      const ids = async (query: string): Promise<unknown[]> =>
        readList(await (await listDecisions(query)).json()).map((decision) => decision.id)

      expect(await ids('confirmed=true')).toEqual([committed.id])
      expect(await ids('confirmed=false')).toEqual([proposed])
      expect((await ids('')).sort()).toEqual([committed.id, proposed].sort())
    })

    it('answers 422 to a ?confirmed= that is not true or false', async () => {
      expect((await listDecisions('confirmed=yes')).status).toBe(422)
    })
  })

  describe('deleting the record a decision is attached to', () => {
    it('takes the decisions with it', async () => {
      const created = await decisionOn(personId, 'Body')

      await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })

      const response = await client.send('GET', `/v1/decisions/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const created = await decisionOn(personId, 'Ship the panel first.', {
        rationale: 'The list page has no data without it.',
        decided_at: '2026-07-01T09:30:00.000Z',
        due_at: '2026-09-01T00:00:00.000Z',
      })

      expect(decisionSchema.parse(created).body).toBe('Ship the panel first.')

      const detail = await client.send('GET', `/v1/decisions/${String(created.id)}`, {
        cookie: acme.cookie,
      })
      expect(decisionSchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await listDecisions()
      expect(readList(await listed.json()).map((item) => decisionSchema.parse(item).id)).toContain(
        created.id,
      )

      const patched = await client.send('PATCH', `/v1/decisions/${String(created.id)}`, {
        body: { body: 'Updated' },
        cookie: acme.cookie,
      })
      expect(decisionSchema.parse(readRecord(await patched.json())).body).toBe('Updated')
    })
  })
})

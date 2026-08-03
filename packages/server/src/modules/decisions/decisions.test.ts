import { decisionSchema } from '@kelpie/schemas'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

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

  function listDecisions(query = '', cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/decisions${query === '' ? '' : `?${query}`}`, { cookie })
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: { NODE_ENV: 'test' },
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app)
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
      const other = await client.owner('grace@example.com', 'other')
      const theirs = await createPerson('Grace Hopper', other.cookie)

      expect(
        (await addDecision({ target_type: 'person', target_id: theirs, body: 'Peek' })).status,
      ).toBe(404)
    })

    it('answers 404 for an owner that is not on this team', async () => {
      const other = await client.owner('grace@example.com', 'other')
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
      const other = await client.owner('grace@example.com', 'other')
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
      const other = await client.owner('grace@example.com', 'other')
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
      const other = await client.owner('grace@example.com', 'other')

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
      const other = await client.owner('grace@example.com', 'other')

      expect(
        (
          await client.send('DELETE', `/v1/decisions/${String(created.id)}`, {
            cookie: other.cookie,
          })
        ).status,
      ).toBe(404)
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

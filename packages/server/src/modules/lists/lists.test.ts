import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { removeListMemberByTarget } from './index.ts'

/** `/v1/lists` against real Postgres. A list holds records of one type only. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('lists', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let personId: string
  let companyId: string

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

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  function createList(body: Record<string, unknown>, cookie = acme.cookie): Promise<Response> {
    return client.send('POST', '/v1/lists', { body, cookie })
  }

  async function createListWith(body: Record<string, unknown>): Promise<string> {
    const response = await createList(body)

    return readString(await response.json(), 'id')
  }

  function addMember(
    listId: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Response> {
    return client.send('POST', `/v1/lists/${listId}/members`, { body, cookie })
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
    companyId = await createCompany('Analytical Engines')
  })

  describe('creating', () => {
    it('creates a list of a given type with a zero member count', async () => {
      const response = await createList({ name: 'Priority people', target_type: 'person' })
      const list = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(list.id).toMatch(/^list_/u)
      expect(list.name).toBe('Priority people')
      expect(list.target_type).toBe('person')
      expect(list.description).toBeNull()
      expect(list.member_count).toBe(0)
    })

    it('accepts a description', async () => {
      const response = await createList({
        name: 'Q4 champions',
        target_type: 'person',
        description: 'People who moved a deal this quarter',
      })

      expect(readRecord(await response.json()).description).toBe(
        'People who moved a deal this quarter',
      )
    })

    it('answers 409 when another list already has that name in this workspace', async () => {
      expect((await createList({ name: 'Priority', target_type: 'person' })).status).toBe(201)
      expect((await createList({ name: 'Priority', target_type: 'company' })).status).toBe(409)
    })

    it('answers 422 for an unknown target type, an empty name, or an unknown field', async () => {
      expect((await createList({ name: 'x', target_type: 'unknown' })).status).toBe(422)
      expect((await createList({ name: '', target_type: 'person' })).status).toBe(422)
      expect(
        (await createList({ name: 'x', target_type: 'person', typo: true })).status,
      ).toBe(422)
    })

    it('answers 401 without credentials', async () => {
      const response = await client.send('POST', '/v1/lists', {
        body: { name: 'x', target_type: 'person' },
      })

      expect(response.status).toBe(401)
    })
  })

  describe('updating', () => {
    it('changes name and description but refuses to change type', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })

      const renamed = await client.send('PATCH', `/v1/lists/${listId}`, {
        body: { name: 'Priority people', description: 'The A tier' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await renamed.json())

      expect(updated.name).toBe('Priority people')
      expect(updated.description).toBe('The A tier')
      expect(updated.target_type).toBe('person')

      // `target_type` on PATCH is a caller error, not a silent no-op.
      const attempted = await client.send('PATCH', `/v1/lists/${listId}`, {
        body: { target_type: 'company' },
        cookie: acme.cookie,
      })
      expect(attempted.status).toBe(422)
    })
  })

  describe('adding members', () => {
    it('adds a matching record and returns it with the resolved name', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      const response = await addMember(listId, { target_type: 'person', target_id: personId })
      const member = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(member.id).toMatch(/^lmem_/u)
      expect(member.list_id).toBe(listId)
      expect(member.target_type).toBe('person')
      expect(member.target_id).toBe(personId)
      expect(member.target_name).toBe('Ada Lovelace')
    })

    it('refuses a mismatched type with 422 and a target_type field error', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      const response = await addMember(listId, {
        target_type: 'company',
        target_id: companyId,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(422)
      const error = body.error as { readonly details?: readonly { readonly field: string }[] }
      expect(error.details?.[0]?.field).toBe('target_type')
    })

    it('answers 404 when the target does not exist', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })

      expect(
        (await addMember(listId, { target_type: 'person', target_id: 'per_nope' })).status,
      ).toBe(404)
    })

    it('answers 409 when the record is already on the list', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })

      expect(
        (await addMember(listId, { target_type: 'person', target_id: personId })).status,
      ).toBe(201)
      expect(
        (await addMember(listId, { target_type: 'person', target_id: personId })).status,
      ).toBe(409)
    })

    it('answers 404 when the list is in another workspace', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const theirsId = readString(
        await (
          await client.send('POST', '/v1/lists', {
            body: { name: 'Theirs', target_type: 'person' },
            cookie: other.cookie,
          })
        ).json(),
        'id',
      )

      expect(
        (await addMember(theirsId, { target_type: 'person', target_id: personId })).status,
      ).toBe(404)
    })
  })

  describe('listing members', () => {
    it('returns members with their resolved names', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      const grace = await createPerson('Grace Hopper')

      await addMember(listId, { target_type: 'person', target_id: personId })
      await addMember(listId, { target_type: 'person', target_id: grace })

      const response = await client.send('GET', `/v1/lists/${listId}/members`, {
        cookie: acme.cookie,
      })
      const members = readList(await response.json())

      expect(members.map((row) => row.target_name).sort()).toEqual(['Ada Lovelace', 'Grace Hopper'])
    })

    it('reports member_count on the list', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      await addMember(listId, { target_type: 'person', target_id: personId })

      const list = readRecord(
        await (await client.send('GET', `/v1/lists/${listId}`, { cookie: acme.cookie })).json(),
      )

      expect(list.member_count).toBe(1)
    })

    it('reports zero for a list nobody has joined', async () => {
      const listId = await createListWith({ name: 'Empty', target_type: 'company' })
      const list = readRecord(
        await (await client.send('GET', `/v1/lists/${listId}`, { cookie: acme.cookie })).json(),
      )

      expect(list.member_count).toBe(0)
    })
  })

  describe('removing members', () => {
    it('removes a member by its id', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      const member = readRecord(
        await (await addMember(listId, { target_type: 'person', target_id: personId })).json(),
      )

      const response = await client.send(
        'DELETE',
        `/v1/lists/${listId}/members/${String(member.id)}`,
        { cookie: acme.cookie },
      )
      expect(response.status).toBe(204)

      const members = readList(
        await (
          await client.send('GET', `/v1/lists/${listId}/members`, { cookie: acme.cookie })
        ).json(),
      )
      expect(members).toEqual([])
    })
  })

  describe('deleting a list', () => {
    it('takes its members with it', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      await addMember(listId, { target_type: 'person', target_id: personId })

      const response = await client.send('DELETE', `/v1/lists/${listId}`, { cookie: acme.cookie })
      expect(response.status).toBe(204)

      const membersResponse = await client.send('GET', `/v1/lists/${listId}/members`, {
        cookie: acme.cookie,
      })
      expect(membersResponse.status).toBe(404)
    })
  })

  describe('listing memberships for a target', () => {
    it('returns lists the record is on, with each list joined in', async () => {
      const priorityId = await createListWith({ name: 'Priority', target_type: 'person' })
      const inactiveId = await createListWith({ name: 'Inactive', target_type: 'person' })
      const unrelatedId = await createListWith({ name: 'Companies', target_type: 'company' })

      await addMember(priorityId, { target_type: 'person', target_id: personId })
      await addMember(unrelatedId, { target_type: 'company', target_id: companyId })

      const response = await client.send(
        'GET',
        `/v1/list-memberships?target_type=person&target_id=${personId}`,
        { cookie: acme.cookie },
      )
      const memberships = readList(await response.json())

      expect(memberships.map((row) => row.list_id)).toEqual([priorityId])
      expect(memberships[0]?.list_name).toBe('Priority')
      expect(memberships[0]?.list_target_type).toBe('person')

      // Sanity: the inactive list is empty, so it should not appear.
      void inactiveId
    })

    it('answers 404 for a target that does not exist', async () => {
      const response = await client.send(
        'GET',
        '/v1/list-memberships?target_type=person&target_id=per_nope',
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(404)
    })

    it('answers 422 without the target filters', async () => {
      const response = await client.send('GET', '/v1/list-memberships', { cookie: acme.cookie })

      expect(response.status).toBe(422)
    })
  })

  describe('deleting the member record', () => {
    it('removes any list memberships pointing at it', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      await addMember(listId, { target_type: 'person', target_id: personId })

      const removal = await client.send('DELETE', `/v1/people/${personId}`, { cookie: acme.cookie })
      expect(removal.status).toBe(204)

      const members = readList(
        await (
          await client.send('GET', `/v1/lists/${listId}/members`, { cookie: acme.cookie })
        ).json(),
      )
      expect(members).toEqual([])
    })
  })

  describe('removeListMemberByTarget (helper for integration modules)', () => {
    it('removes the target from the list and returns true', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })
      await addMember(listId, { target_type: 'person', target_id: personId })

      const removed = await removeListMemberByTarget(
        { db: harness.services.db, transaction: harness.services.transaction },
        {
          workspaceId: acme.workspaceId,
          listId,
          targetType: 'person',
          targetId: personId,
          actor: { kind: 'system' },
        },
      )

      expect(removed).toBe(true)

      const members = readList(
        await (
          await client.send('GET', `/v1/lists/${listId}/members`, { cookie: acme.cookie })
        ).json(),
      )
      expect(members).toEqual([])
    })

    it('returns false when the target was not on the list', async () => {
      const listId = await createListWith({ name: 'People', target_type: 'person' })

      const removed = await removeListMemberByTarget(
        { db: harness.services.db, transaction: harness.services.transaction },
        {
          workspaceId: acme.workspaceId,
          listId,
          targetType: 'person',
          targetId: personId,
          actor: { kind: 'system' },
        },
      )

      expect(removed).toBe(false)
    })
  })
})

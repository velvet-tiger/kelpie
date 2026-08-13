import { positionSchema } from '@kelpie/schemas'
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

/** `/v1/positions` against real Postgres. The person-to-company link, and the only home of a job title. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('positions', () => {
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

  function link(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Response> {
    return client.send('POST', '/v1/positions', { body, cookie })
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
    it('links a person to a company with a title', async () => {
      const response = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Chief Mathematician',
      })
      const position = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(position.id).toMatch(/^pos_/u)
      expect(position.person_id).toBe(personId)
      expect(position.company_id).toBe(companyId)
      expect(position.title).toBe('Chief Mathematician')
    })

    it('lets one person hold titles at several companies', async () => {
      const other = await createCompany('Second Corp')

      await link({ person_id: personId, company_id: companyId, title: 'Chief Mathematician' })
      const second = await link({ person_id: personId, company_id: other, title: 'Advisor' })

      expect(second.status).toBe(201)
    })

    it('answers 409 for the same title twice at the same company', async () => {
      await link({ person_id: personId, company_id: companyId, title: 'Chief Mathematician' })

      const repeat = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Chief Mathematician',
      })

      expect(repeat.status).toBe(409)
    })

    it('refuses a missing field with 422', async () => {
      expect((await link({ person_id: personId, company_id: companyId })).status).toBe(422)
      expect((await link({ person_id: personId, title: 'Advisor' })).status).toBe(422)
    })

    it('refuses an unknown field with 422', async () => {
      const response = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Advisor',
        started_at: '2026-01-01',
      })

      expect(response.status).toBe(422)
    })

    it('answers 404 for a person in another workspace', async () => {
      const initech = await client.owner('grace@example.com', 'initech')
      const theirPerson = await createPerson('Grace Hopper', initech.cookie)

      const response = await link({
        person_id: theirPerson,
        company_id: companyId,
        title: 'Advisor',
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for a company in another workspace', async () => {
      const initech = await client.owner('grace@example.com', 'initech')
      const theirCompany = await createCompany('Initech', initech.cookie)

      const response = await link({
        person_id: personId,
        company_id: theirCompany,
        title: 'Advisor',
      })

      expect(response.status).toBe(404)
    })

    it('answers 401 without credentials', async () => {
      const response = await client.send('POST', '/v1/positions', {
        body: { person_id: personId, company_id: companyId, title: 'Advisor' },
      })

      expect(response.status).toBe(401)
    })
  })

  describe('listing', () => {
    beforeEach(async () => {
      await link({ person_id: personId, company_id: companyId, title: 'Chief Mathematician' })
    })

    it('filters by person and by company', async () => {
      const otherPerson = await createPerson('Charles Babbage')
      const otherCompany = await createCompany('Second Corp')
      await link({ person_id: otherPerson, company_id: otherCompany, title: 'Inventor' })

      const byPerson = await client.send(`GET`, `/v1/positions?person_id=${personId}`, {
        cookie: acme.cookie,
      })
      const byCompany = await client.send('GET', `/v1/positions?company_id=${otherCompany}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byPerson.json()).map((row) => row.title)).toEqual(['Chief Mathematician'])
      expect(readList(await byCompany.json()).map((row) => row.title)).toEqual(['Inventor'])
    })

    it('lists only this workspace', async () => {
      const initech = await client.owner('grace@example.com', 'initech')

      const theirs = await client.send('GET', '/v1/positions', { cookie: initech.cookie })

      expect(readList(await theirs.json())).toEqual([])
    })

    it('refuses an undocumented sort field', async () => {
      const response = await client.send('GET', '/v1/positions?sort=person_id', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('updating', () => {
    let positionId: string

    beforeEach(async () => {
      const created = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Chief Mathematician',
      })
      positionId = readString(await created.json(), 'id')
    })

    it('changes the title', async () => {
      const response = await client.send('PATCH', `/v1/positions/${positionId}`, {
        body: { title: 'Principal Mathematician' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).title).toBe('Principal Mathematician')
    })

    it('refuses to repoint the link at another person', async () => {
      const response = await client.send('PATCH', `/v1/positions/${positionId}`, {
        body: { person_id: await createPerson('Charles Babbage') },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('answers 404 across a workspace boundary', async () => {
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('PATCH', `/v1/positions/${positionId}`, {
        body: { title: 'Not yours' },
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('answers 204, and leaves both ends standing', async () => {
      const created = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Chief Mathematician',
      })
      const positionId = readString(await created.json(), 'id')

      const deleted = await client.send('DELETE', `/v1/positions/${positionId}`, {
        cookie: acme.cookie,
      })

      expect(deleted.status).toBe(204)
      expect(
        (await client.send('GET', `/v1/positions/${positionId}`, { cookie: acme.cookie })).status,
      ).toBe(404)
      expect((await client.send('GET', `/v1/people/${personId}`, { cookie: acme.cookie })).status).toBe(200)
      expect(
        (await client.send('GET', `/v1/companies/${companyId}`, { cookie: acme.cookie })).status,
      ).toBe(200)
    })

    it('answers 404 across a workspace boundary', async () => {
      const created = await link({
        person_id: personId,
        company_id: companyId,
        title: 'Chief Mathematician',
      })
      const positionId = readString(await created.json(), 'id')
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('DELETE', `/v1/positions/${positionId}`, {
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('filtering by a set of ids', () => {
    it('takes person_id more than once, so a list page resolves in one request', async () => {
      const ada = await createPerson('Ada Lovelace')
      const grace = await createPerson('Grace Hopper')
      const mary = await createPerson('Mary Jackson')
      const harbour = await createCompany('Harbour')

      for (const personId of [ada, grace, mary]) {
        await link({ person_id: personId, company_id: harbour, title: 'Engineer' })
      }

      const response = await client.send(
        'GET',
        `/v1/positions?person_id=${ada}&person_id=${grace}`,
        { cookie: acme.cookie },
      )

      expect(readList(await response.json()).map((row) => row.person_id).sort()).toEqual(
        [ada, grace].sort(),
      )
    })

    it('takes company_id more than once', async () => {
      const ada = await createPerson('Ada Lovelace')
      const harbour = await createCompany('Harbour')
      const initech = await createCompany('Initech')
      const ignored = await createCompany('Ignored')

      for (const companyId of [harbour, initech, ignored]) {
        await link({ person_id: ada, company_id: companyId, title: 'Advisor' })
      }

      const response = await client.send(
        'GET',
        `/v1/positions?company_id=${harbour}&company_id=${initech}`,
        { cookie: acme.cookie },
      )

      expect(readList(await response.json()).map((row) => row.company_id).sort()).toEqual(
        [harbour, initech].sort(),
      )
    })

    it('refuses more ids than a page could hold', async () => {
      const tooMany = Array.from({ length: 201 }, (_, index) => `person_id=per_${String(index)}`)
      const response = await client.send('GET', `/v1/positions?${tooMany.join('&')}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  /** The client decodes with `positionSchema`. See the note in `people.test.ts`. */
  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const personId = await createPerson('Ada Lovelace')
      const companyId = await createCompany('Harbour Analytics')
      const created = readRecord(
        await (
          await link({ person_id: personId, company_id: companyId, title: 'Chief Mathematician' })
        ).json(),
      )

      expect(positionSchema.parse(created).title).toBe('Chief Mathematician')

      const detail = await client.send('GET', `/v1/positions/${String(created.id)}`, { cookie: acme.cookie })
      expect(positionSchema.parse(readRecord(await detail.json())).personId).toBe(personId)

      const listed = await client.send('GET', '/v1/positions', { cookie: acme.cookie })
      expect(readList(await listed.json()).map((item) => positionSchema.parse(item).id)).toContain(created.id)

      const patched = await client.send('PATCH', `/v1/positions/${String(created.id)}`, {
        body: { title: 'Head of Data' },
        cookie: acme.cookie,
      })
      expect(positionSchema.parse(readRecord(await patched.json())).title).toBe('Head of Data')
    })
  })
})

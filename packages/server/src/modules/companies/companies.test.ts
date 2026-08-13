import { companySchema } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import {
  createTestClient,
  readCursor,
  readList,
  readRecord,
  readString,
} from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { deals } from '../deals/schema.ts'
import { notes } from '../notes/schema.ts'
import { pipelineStages } from '../pipelines/schema.ts'

/** `/v1/companies` against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

describe.skipIf(connectionString === undefined)('companies', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

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
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

  async function createCompany(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/companies', { body, cookie })

    if (response.status !== 201) {
      throw new Error(`Creating a company answered ${String(response.status)}: ${await response.text()}`)
    }

    return readRecord(await response.json())
  }

  describe('creating', () => {
    it('needs only a name, and defaults the rest the way the UI does', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })

      expect(company.id).toMatch(/^com_/u)
      expect(company.domain).toBeNull()
      expect(company.industry).toBeNull()
      expect(company.description).toBe('')
      expect(company.stage).toBe('startup')
      expect(company.size_band).toBe('1-10')
      expect(company.account_type).toBe('prospect')
      expect(company.icp_fit).toBe('unknown')
      expect(company.tech_stack).toEqual([])
      expect(company.tags).toEqual([])
      expect(String(company.created_at)).toMatch(ISO_8601_UTC)
    })

    it('reduces a pasted URL to its host', async () => {
      const company = await createCompany({
        name: 'Analytical Engines',
        domain: 'HTTPS://Analytical.example/about?ref=x',
      })

      expect(company.domain).toBe('analytical.example')
    })

    it('stores a blank domain as null rather than as an empty string', async () => {
      const first = await createCompany({ name: 'One', domain: '' })
      const second = await createCompany({ name: 'Two', domain: '   ' })

      expect(first.domain).toBeNull()
      expect(second.domain).toBeNull()
    })

    it('refuses an unknown enum value with 422', async () => {
      const response = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines', icp_fit: 'perfect' },
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(422)
      expect(readRecord(body.error).details).toContainEqual(
        expect.objectContaining({ field: 'icp_fit' }),
      )
    })

    it('refuses an unknown field with 422 rather than dropping it', async () => {
      const response = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines', linkedin_url: 'https://example.com' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('answers 409 for a duplicate domain in the same workspace', async () => {
      await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

      const response = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines Ltd', domain: 'https://ANALYTICAL.example' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)
    })

    it('allows the same domain in a different workspace', async () => {
      await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines', domain: 'analytical.example' },
        cookie: initech.cookie,
      })

      expect(response.status).toBe(201)
    })
  })

  describe('reading', () => {
    it('answers 401 without credentials', async () => {
      expect((await client.send('GET', '/v1/companies')).status).toBe(401)
    })

    it('answers 403 before the account has a workspace', async () => {
      const cookie = await client.signUp('nobody@example.com')

      expect((await client.send('GET', '/v1/companies', { cookie })).status).toBe(403)
    })

    it('answers 404 for a company in another workspace', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('GET', `/v1/companies/${String(company.id)}`, {
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('filtering', () => {
    it('matches name, domain, industry, summary, account type and tags', async () => {
      await createCompany({
        name: 'Analytical Engines',
        domain: 'analytical.example',
        industry: 'Hardware',
      })
      await createCompany({ name: 'Second Corp', summary: 'Runs the ledger', account_type: 'customer' })
      await createCompany({ name: 'Third Corp', tags: ['renewal-risk'] })

      const matching = async (term: string): Promise<string[]> => {
        const response = await client.send('GET', `/v1/companies?q=${encodeURIComponent(term)}`, {
          cookie: acme.cookie,
        })

        return readList(await response.json()).map((row) => String(row.name))
      }

      expect(await matching('analytical.exa')).toEqual(['Analytical Engines'])
      expect(await matching('hardware')).toEqual(['Analytical Engines'])
      expect(await matching('ledger')).toEqual(['Second Corp'])
      expect(await matching('customer')).toEqual(['Second Corp'])
      expect(await matching('renewal')).toEqual(['Third Corp'])
    })

    it('filters by person through positions', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      await createCompany({ name: 'Somewhere Else' })
      const person = readRecord(
        await (
          await client.send('POST', '/v1/people', { body: { name: 'Ada' }, cookie: acme.cookie })
        ).json(),
      )
      await client.send('POST', '/v1/positions', {
        body: { person_id: person.id, company_id: company.id, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })

      const response = await client.send('GET', `/v1/companies?person_id=${String(person.id)}`, {
        cookie: acme.cookie,
      })

      expect(readList(await response.json()).map((row) => row.name)).toEqual(['Analytical Engines'])
    })
  })

  describe('paging', () => {
    it('pages with an opaque cursor and stops with a null one', async () => {
      for (const name of ['Alpha', 'Bravo', 'Charlie']) {
        await createCompany({ name })
      }

      const first = await (
        await client.send('GET', '/v1/companies?limit=2', { cookie: acme.cookie })
      ).json()
      const cursor = readCursor(first)

      expect(readList(first)).toHaveLength(2)
      expect(cursor).not.toBeNull()

      const second = await (
        await client.send('GET', `/v1/companies?limit=2&cursor=${encodeURIComponent(String(cursor))}`, {
          cookie: acme.cookie,
        })
      ).json()

      expect(readList(second)).toHaveLength(1)
      expect(readCursor(second)).toBeNull()
    })
  })

  describe('updating', () => {
    it('changes only the fields it was sent', async () => {
      const company = await createCompany({ name: 'Analytical Engines', summary: 'Original' })

      const response = await client.send('PATCH', `/v1/companies/${String(company.id)}`, {
        body: { icp_fit: 'high', summary: 'Rewritten' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(updated.icp_fit).toBe('high')
      expect(updated.summary).toBe('Rewritten')
      expect(updated.name).toBe('Analytical Engines')
    })

    it('clears a nullable field with null', async () => {
      const company = await createCompany({ name: 'Analytical Engines', hq: 'London' })

      const response = await client.send('PATCH', `/v1/companies/${String(company.id)}`, {
        body: { hq: null },
        cookie: acme.cookie,
      })

      expect(readRecord(await response.json()).hq).toBeNull()
    })

    it('answers 404 across a workspace boundary', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('PATCH', `/v1/companies/${String(company.id)}`, {
        body: { summary: 'Not yours' },
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('answers 204 and takes its positions and notes with it', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      const companyId = String(company.id)
      const person = readRecord(
        await (
          await client.send('POST', '/v1/people', { body: { name: 'Ada' }, cookie: acme.cookie })
        ).json(),
      )
      await client.send('POST', '/v1/positions', {
        body: { person_id: person.id, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })
      await database.db.insert(notes).values({
        id: 'note_company_one',
        workspaceId: acme.workspaceId,
        targetType: 'company',
        targetId: companyId,
        body: 'Met the board',
      })

      const deleted = await client.send('DELETE', `/v1/companies/${companyId}`, {
        cookie: acme.cookie,
      })

      expect(deleted.status).toBe(204)
      expect(readList(await (await client.send('GET', '/v1/positions', { cookie: acme.cookie })).json())).toEqual([])
      expect(await database.db.select().from(notes).where(eq(notes.targetId, companyId))).toEqual([])
      // The person outlives the company: only the link between them was a dependent.
      expect(
        (await client.send('GET', `/v1/people/${String(person.id)}`, { cookie: acme.cookie })).status,
      ).toBe(200)
    })

    it('answers 409 while a deal still points at it', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      const [stage] = await database.db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.kind, 'deal'))
        .limit(1)

      await database.db.insert(deals).values({
        id: 'deal_company_one',
        workspaceId: acme.workspaceId,
        name: 'Engine rollout',
        companyId: String(company.id),
        stageId: String(stage?.id),
      })

      const response = await client.send('DELETE', `/v1/companies/${String(company.id)}`, {
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status).toBe(409)
      expect(readRecord(body.error).details).toContainEqual(
        expect.objectContaining({ message: 'Referenced by deal' }),
      )
    })

    it('answers 404 across a workspace boundary', async () => {
      const company = await createCompany({ name: 'Analytical Engines' })
      const initech = await client.owner('grace@example.com', 'initech')

      const response = await client.send('DELETE', `/v1/companies/${String(company.id)}`, {
        cookie: initech.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('a workspace API key', () => {
    it('can write as well as read', async () => {
      const minted = await client.send('POST', '/v1/api-keys', {
        body: { name: 'CI', kind: 'workspace' },
        cookie: acme.cookie,
      })
      const secret = readString(await minted.json(), 'secret')

      const created = await client.send('POST', '/v1/companies', {
        body: { name: 'Written by an agent' },
        bearer: secret,
      })

      expect(created.status).toBe(201)
    })
  })

  describe('filtering by a set of ids', () => {
    it('takes person_id more than once, and answers for any of them', async () => {
      const harbour = await createCompany({ name: 'Harbour' })
      const initech = await createCompany({ name: 'Initech' })
      await createCompany({ name: 'Unconnected' })
      const ada = readString(
        await (await client.send('POST', '/v1/people', { body: { name: 'Ada' }, cookie: acme.cookie })).json(),
        'id',
      )
      const grace = readString(
        await (await client.send('POST', '/v1/people', { body: { name: 'Grace' }, cookie: acme.cookie })).json(),
        'id',
      )

      await client.send('POST', '/v1/positions', {
        body: { person_id: ada, company_id: harbour.id, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/positions', {
        body: { person_id: grace, company_id: initech.id, title: 'Rear Admiral' },
        cookie: acme.cookie,
      })

      const response = await client.send(
        'GET',
        `/v1/companies?person_id=${ada}&person_id=${grace}&sort=name`,
        { cookie: acme.cookie },
      )

      expect(readList(await response.json()).map((row) => row.name)).toEqual(['Harbour', 'Initech'])
    })

    it('refuses more ids than a page could hold', async () => {
      const tooMany = Array.from({ length: 201 }, (_, index) => `person_id=per_${String(index)}`)
      const response = await client.send('GET', `/v1/companies?${tooMany.join('&')}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  /** The client decodes with `companySchema`. See the note in `people.test.ts`. */
  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const created = await createCompany({
        name: 'Harbour Analytics',
        domain: 'harbour.dev',
        industry: 'Analytics',
        description: 'Warehouse-native analytics.',
        stage: 'growth',
        size_band: '11-50',
        hq: 'Sydney',
        website: 'https://harbour.dev',
        account_type: 'customer',
        icp_fit: 'high',
        tech_stack: ['postgres'],
        summary: 'Expanding into APAC.',
        tags: ['apac'],
      })

      expect(companySchema.parse(created).name).toBe('Harbour Analytics')

      const detail = await client.send('GET', `/v1/companies/${String(created.id)}`, { cookie: acme.cookie })
      expect(companySchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/companies', { cookie: acme.cookie })
      expect(readList(await listed.json()).map((item) => companySchema.parse(item).id)).toContain(created.id)

      const patched = await client.send('PATCH', `/v1/companies/${String(created.id)}`, {
        body: { summary: 'Updated' },
        cookie: acme.cookie,
      })
      expect(companySchema.parse(readRecord(await patched.json())).summary).toBe('Updated')
    })
  })
})

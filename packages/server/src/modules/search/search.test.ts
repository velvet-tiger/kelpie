import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

/**
 * `GET /v1/search` against real Postgres.
 *
 * The generated `search_vector` columns are the thing under test as much as the
 * endpoint is. Nothing here writes one: every record goes in through the API, so
 * a vector that failed to populate shows up as a record that cannot be found.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('search', () => {
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

  async function create(
    path: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', path, { body, cookie })

    expect(response.status, `POST ${path} answered ${await response.clone().text()}`).toBe(201)

    return readRecord(await response.json())
  }

  async function createCompany(
    name = 'Northwind',
    extra: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<string> {
    return readString(await create('/v1/companies', { name, ...extra }, cookie), 'id')
  }

  async function createPerson(
    name: string,
    extra: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<string> {
    return readString(await create('/v1/people', { name, ...extra }, cookie), 'id')
  }

  async function stageId(kind: string, slug: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', `/v1/pipeline_stages?kind=${kind}`, { cookie })
    const payload = readRecord(await response.json())
    const stages = Array.isArray(payload.data) ? payload.data : []
    const found = stages.map((stage) => readRecord(stage)).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No ${kind} stage "${slug}" in ${JSON.stringify(stages)}`)
    }

    return readString(found, 'id')
  }

  function get(query: string, cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/search?${query}`, { cookie })
  }

  /** No credentials at all, which a default parameter cannot express. */
  function getAnonymously(query: string): Promise<Response> {
    return client.send('GET', `/v1/search?${query}`)
  }

  async function search(query: string): Promise<Record<string, unknown>> {
    const response = await get(query)

    expect(response.status, await response.clone().text()).toBe(200)

    return readRecord(await response.json())
  }

  /** One group out of a response, by collection name. */
  function group(payload: Record<string, unknown>, type: string): Record<string, unknown> {
    const groups = Array.isArray(payload.groups) ? payload.groups.map(readRecord) : []
    const found = groups.find((entry) => entry.type === type)

    if (found === undefined) {
      throw new Error(`No "${type}" group in ${JSON.stringify(groups.map((g) => g.type))}`)
    }

    return found
  }

  function items(payload: Record<string, unknown>, type: string): Record<string, unknown>[] {
    const entry = group(payload, type)

    return Array.isArray(entry.items) ? entry.items.map(readRecord) : []
  }

  function titles(payload: Record<string, unknown>, type: string): string[] {
    return items(payload, type).map((item) => readString(item, 'title'))
  }

  describe('shape', () => {
    it('answers every collection, in a fixed order, even with nothing to find', async () => {
      const payload = await search('q=nothingmatchesthis')

      expect(payload.total).toBe(0)
      expect(Array.isArray(payload.groups) ? payload.groups.map((g) => readRecord(g).type) : []).toEqual([
        'handbook_page',
        'person',
        'role',
        'company',
        'deal',
        'opportunity',
        'raise',
        'partnership',
        'decision',
      ])
    })

    it('echoes the query and the limit it used', async () => {
      const payload = await search('q=acme&limit=3')

      expect(payload.query).toBe('acme')
      expect(payload.limit).toBe(3)
    })

    it('totals every group', async () => {
      await createPerson('Acme Contact')
      await createCompany('Acme Corp')

      const payload = await search('q=acme')

      expect(payload.total).toBe(2)
    })
  })

  describe('matching', () => {
    it('finds a person by name, email, summary and tag', async () => {
      await createPerson('Ada Lovelace', {
        email: 'ada@analytical.test',
        summary: 'Runs the engine programme',
        tags: ['warm-intro'],
      })

      expect(titles(await search('q=lovelace'), 'person')).toEqual(['Ada Lovelace'])
      expect(titles(await search('q=analytical'), 'person')).toEqual(['Ada Lovelace'])
      expect(titles(await search('q=programme'), 'person')).toEqual(['Ada Lovelace'])
      expect(titles(await search('q=warm-intro'), 'person')).toEqual(['Ada Lovelace'])
    })

    it('finds a person by a name part they are not displayed under', async () => {
      // The point of storing the parts: the display name is what the team calls
      // her, and the surname is only in `last_name`. Searching a surname and
      // finding nobody is what this is here to stop.
      await createPerson('Kit', { first_name: 'Katherine', last_name: 'Johnson' })

      expect(titles(await search('q=johnson'), 'person')).toEqual(['Kit'])
      expect(titles(await search('q=katherine'), 'person')).toEqual(['Kit'])
    })

    it('matches a partial word, because a search box is typed into', async () => {
      await createCompany('Acme Corporation')

      expect(titles(await search('q=acm'), 'company')).toEqual(['Acme Corporation'])
    })

    it('requires every word, so a second word narrows rather than widens', async () => {
      await createCompany('Acme Corporation')
      await createCompany('Beta Corporation')

      expect(titles(await search('q=corporation'), 'company')).toHaveLength(2)
      expect(titles(await search('q=acme corporation'), 'company')).toEqual(['Acme Corporation'])
    })

    it('stems, so a plural finds the singular', async () => {
      await createCompany('Northwind', { summary: 'We hold a meeting each Tuesday' })

      expect(titles(await search('q=meetings'), 'company')).toEqual(['Northwind'])
    })

    it('is case insensitive', async () => {
      await createCompany('Northwind')

      expect(titles(await search('q=NORTHWIND'), 'company')).toEqual(['Northwind'])
    })

    it('finds a person by the job title on their position', async () => {
      const personId = await createPerson('Grace Hopper')
      const companyId = await createCompany('Univac')

      await create('/v1/positions', {
        person_id: personId,
        company_id: companyId,
        title: 'VP Partnerships',
      })

      expect(titles(await search('q=partnerships'), 'person')).toEqual(['Grace Hopper'])
    })

    it('finds a deal by the title of one of its plan items', async () => {
      const companyId = await createCompany('Initech')
      const dealId = readString(
        await create('/v1/deals', {
          name: 'Platform rollout',
          company_id: companyId,
          stage_id: await stageId('deal', 'qualifying'),
        }),
        'id',
      )

      await create('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send the revised quotation',
      })

      expect(titles(await search('q=quotation'), 'deal')).toEqual(['Platform rollout'])
    })

    it('counts a record once when it matches both itself and a related record', async () => {
      const companyId = await createCompany('Initech')
      const dealId = readString(
        await create('/v1/deals', {
          name: 'Quotation rollout',
          company_id: companyId,
          stage_id: await stageId('deal', 'qualifying'),
        }),
        'id',
      )

      await create('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send the quotation',
      })

      const payload = await search('q=quotation')

      expect(group(payload, 'deal').total).toBe(1)
      expect(titles(payload, 'deal')).toEqual(['Quotation rollout'])
    })

    it('finds a handbook page by its body', async () => {
      await create('/v1/handbook_pages', {
        title: 'How we sell',
        body: '## Discovery\n\nAlways establish the compelling event first.',
      })

      expect(titles(await search('q=compelling'), 'handbook_page')).toEqual(['How we sell'])
    })

    it('finds a role, a partnership, an opportunity, a raise and a decision', async () => {
      const companyId = await createCompany('Globex')

      await create('/v1/roles', { title: 'Staff Engineer' })
      await create('/v1/partnerships', {
        name: 'Globex integration',
        company_id: companyId,
        stage_id: await stageId('partnership', 'active'),
        kind: 'integration',
      })
      await create('/v1/opportunities', {
        name: 'Innovation grant',
        kind: 'grant',
        stage_id: await stageId('opportunity', 'identified'),
      })
      await create('/v1/raises', {
        name: 'Globex Ventures seed',
        company_id: companyId,
        stage_id: await stageId('raise', 'researching'),
        thesis_fit: 'They back climate infrastructure',
      })
      await create('/v1/decisions', {
        target_type: 'company',
        target_id: companyId,
        body: 'We promised a quarterly business review',
      })

      expect(titles(await search('q=engineer'), 'role')).toEqual(['Staff Engineer'])
      expect(titles(await search('q=integration'), 'partnership')).toEqual(['Globex integration'])
      expect(titles(await search('q=grant'), 'opportunity')).toEqual(['Innovation grant'])
      expect(titles(await search('q=climate'), 'raise')).toEqual(['Globex Ventures seed'])
      expect(titles(await search('q=quarterly'), 'decision')).toEqual([
        'We promised a quarterly business review',
      ])
    })

    it('reflects an edit, because the vector is generated rather than written', async () => {
      const companyId = await createCompany('Placeholder')

      await client.send('PATCH', `/v1/companies/${companyId}`, {
        body: { name: 'Renamed Industries' },
        cookie: acme.cookie,
      })

      expect(titles(await search('q=renamed'), 'company')).toEqual(['Renamed Industries'])
      expect(titles(await search('q=placeholder'), 'company')).toEqual([])
    })
  })

  describe('ranking and snippets', () => {
    it('puts a match on the name above a match on the prose', async () => {
      await createCompany('Beacon Systems', { summary: 'Unrelated' })
      await createCompany('Unrelated Ltd', { summary: 'A supplier to Beacon Systems' })

      expect(titles(await search('q=beacon'), 'company')[0]).toBe('Beacon Systems')
    })

    it('puts a match on the record above a match on a related record', async () => {
      const companyId = await createCompany('Initech')
      const stage = await stageId('deal', 'qualifying')
      const relatedId = readString(
        await create('/v1/deals', { name: 'Second deal', company_id: companyId, stage_id: stage }),
        'id',
      )

      await create('/v1/deals', {
        name: 'Migration project',
        company_id: companyId,
        stage_id: stage,
      })
      await create('/v1/plan_items', {
        target_type: 'deal',
        target_id: relatedId,
        date: '2026-09-01',
        title: 'Plan the migration',
      })

      expect(titles(await search('q=migration'), 'deal')).toEqual(['Migration project', 'Second deal'])
    })

    it('centres the snippet on the match', async () => {
      await create('/v1/handbook_pages', {
        title: 'Voice',
        body: `${'padding '.repeat(40)}we never use exclamation marks${' more '.repeat(40)}`,
      })

      const [page] = items(await search('q=exclamation'), 'handbook_page')

      expect(readString(page ?? {}, 'snippet')).toContain('exclamation marks')
    })

    it('carries the one line of context as the subtitle', async () => {
      await createPerson('Ada Lovelace', { email: 'ada@analytical.test' })

      const [person] = items(await search('q=lovelace'), 'person')

      expect(person?.subtitle).toBe('ada@analytical.test')
    })

    it('names the stage as the subtitle of a deal', async () => {
      const companyId = await createCompany('Initech')

      await create('/v1/deals', {
        name: 'Platform rollout',
        company_id: companyId,
        stage_id: await stageId('deal', 'qualifying'),
      })

      const [deal] = items(await search('q=rollout'), 'deal')

      expect(typeof deal?.subtitle).toBe('string')
      expect(deal?.subtitle).not.toBe('')
    })
  })

  describe('limit and totals', () => {
    it('caps each group and still reports the exact total', async () => {
      for (let index = 0; index < 5; index += 1) {
        await createCompany(`Acme ${String(index)}`)
      }

      const payload = await search('q=acme&limit=2')

      expect(items(payload, 'company')).toHaveLength(2)
      expect(group(payload, 'company').total).toBe(5)
      expect(payload.total).toBe(5)
    })
  })

  describe('type filter', () => {
    it('answers only the collections named', async () => {
      await createPerson('Acme Contact')
      await createCompany('Acme Corp')

      const payload = await search('q=acme&type=company')
      const groups = Array.isArray(payload.groups) ? payload.groups.map(readRecord) : []

      expect(groups.map((entry) => entry.type)).toEqual(['company'])
      expect(payload.total).toBe(1)
    })

    it('takes the parameter twice to name a set', async () => {
      const payload = await search('q=acme&type=company&type=person')
      const groups = Array.isArray(payload.groups) ? payload.groups.map(readRecord) : []

      // Back in the canonical order, not the order they were asked for in.
      expect(groups.map((entry) => entry.type)).toEqual(['person', 'company'])
    })

    it('refuses a collection that does not exist', async () => {
      const response = await get('q=acme&type=unicorn')

      expect(response.status).toBe(422)
    })
  })

  describe('validation', () => {
    it('requires q', async () => {
      expect((await get('')).status).toBe(422)
    })

    it('refuses a blank q', async () => {
      expect((await get('q=')).status).toBe(422)
      expect((await get('q=%20%20')).status).toBe(422)
    })

    it('refuses a q longer than the boundary allows', async () => {
      expect((await get(`q=${'a'.repeat(201)}`)).status).toBe(422)
    })

    it('refuses a limit out of range', async () => {
      expect((await get('q=acme&limit=0')).status).toBe(422)
      expect((await get('q=acme&limit=201')).status).toBe(422)
      expect((await get('q=acme&limit=two')).status).toBe(422)
    })

    it('answers a query made only of punctuation with empty groups', async () => {
      await createCompany('Acme Corp')

      const payload = await search('q=%26%7C%21')

      expect(payload.total).toBe(0)
      expect(items(payload, 'company')).toEqual([])
    })
  })

  describe('auth and isolation', () => {
    it('refuses a caller with no credentials', async () => {
      expect((await getAnonymously('q=acme')).status).toBe(401)
    })

    it('never returns records from another workspace', async () => {
      await createCompany('Acme Corp')

      const other = await client.owner('other@example.test', 'other')
      const response = await get('q=acme', other.cookie)

      expect(response.status).toBe(200)

      const payload = readRecord(await response.json())

      expect(payload.total).toBe(0)
      expect(items(payload, 'company')).toEqual([])
    })
  })
})

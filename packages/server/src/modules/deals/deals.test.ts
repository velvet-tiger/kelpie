import { eq } from 'drizzle-orm'
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
import { planItems } from '../plans/schema.ts'

/** `/v1/deals` against real Postgres. The sales pipeline: CRUD, person links, stage moves. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('deals', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
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

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
    companyId = await createCompany('Analytical Engines')
  })

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function dealStage(slug: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=deal', { cookie })
    const found = readList(await response.json()).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No deal stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  async function createDeal(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/deals', {
      body: { name: 'Engine rollout', company_id: companyId, ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function activitiesFor(dealId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=deal&target_id=${dealId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('creating', () => {
    it('creates a deal from a name and a company, with honest defaults', async () => {
      const deal = await createDeal({})

      expect(deal.id).toMatch(/^deal_/u)
      expect(deal.name).toBe('Engine rollout')
      expect(deal.company_id).toBe(companyId)
      expect(deal.stage_id).toBe(await dealStage('qualifying'))
      expect(deal.value_cents).toBeNull()
      expect(deal.currency).toBe('USD')
      expect(deal.owner_id).toMatch(/^mem_/u)
      expect(deal.expected_close).toBeNull()
      expect(deal.person_ids).toEqual([])
      expect(deal.competitors).toEqual([])
      expect(deal.risks).toBe('')
      expect(deal.why_win).toBe('')
      expect(deal.summary).toBe('')
      expect(deal.tags).toEqual([])
      expect(deal.external_id).toBeNull()
    })

    it('files the creation on the deal\'s timeline', async () => {
      const deal = await createDeal({})
      const activities = await activitiesFor(readString(deal, 'id'))

      expect(activities.some((activity) => activity.action === 'created Deal')).toBe(true)
    })

    it('links people and names each on the timeline', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const deal = await createDeal({ person_ids: [ada, charles] })

      expect(deal.person_ids).toEqual([ada, charles].sort())

      const linked = (await activitiesFor(readString(deal, 'id'))).filter(
        (activity) => activity.kind === 'linked',
      )

      expect(linked.map((activity) => activity.detail).sort()).toEqual([
        'Ada Lovelace',
        'Charles Babbage',
      ])
    })

    it('takes agent fields, value, and close date', async () => {
      const deal = await createDeal({
        stage_id: await dealStage('proposal'),
        value_cents: 1_200_000,
        currency: 'AUD',
        expected_close: '2026-09-30',
        competitors: ['Difference Engine Co'],
        risks: 'Long procurement cycle',
        why_win: 'Only mechanical option',
        summary: 'Flagship rollout',
        tags: ['flagship'],
        external_id: 'hs-341',
      })

      expect(deal.stage_id).toBe(await dealStage('proposal'))
      expect(deal.value_cents).toBe(1_200_000)
      expect(deal.currency).toBe('AUD')
      expect(deal.expected_close).toBe('2026-09-30')
      expect(deal.competitors).toEqual(['Difference Engine Co'])
      expect(deal.external_id).toBe('hs-341')
    })

    it('refuses a stage from another pipeline with 422', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=raise', {
        cookie: acme.cookie,
      })
      const raiseStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/deals', {
        body: { name: 'Wrong board', company_id: companyId, stage_id: raiseStage },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('reports references outside the workspace as missing', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignCompany = await createCompany('Foreign Co', other.cookie)
      const foreignPerson = await createPerson('Grace Hopper', other.cookie)

      const badCompany = await client.send('POST', '/v1/deals', {
        body: { name: 'Nope', company_id: foreignCompany },
        cookie: acme.cookie,
      })
      const badPerson = await client.send('POST', '/v1/deals', {
        body: { name: 'Nope', company_id: companyId, person_ids: [foreignPerson] },
        cookie: acme.cookie,
      })

      expect(badCompany.status).toBe(404)
      expect(badPerson.status).toBe(404)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        { company_id: companyId },
        { name: 'X', company_id: companyId, value_cents: -1 },
        { name: 'X', company_id: companyId, currency: 'dollars' },
        { name: 'X', company_id: companyId, expected_close: '2026-02-30' },
        { name: 'X', company_id: companyId, next_step: 'call' },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/deals', { body, cookie: acme.cookie })

        expect(response.status).toBe(422)
      }
    })
  })

  describe('listing', () => {
    it('filters by company, stage, and person', async () => {
      const otherCompany = await createCompany('Second Corp')
      const ada = await createPerson('Ada Lovelace')
      const first = await createDeal({ name: 'First' })
      const second = await createDeal({
        name: 'Second',
        company_id: otherCompany,
        stage_id: await dealStage('proposal'),
        person_ids: [ada],
      })

      const byCompany = await client.send('GET', `/v1/deals?company_id=${otherCompany}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byCompany.json()).map((deal) => deal.id)).toEqual([
        readString(second, 'id'),
      ])

      const byStage = await client.send(
        'GET',
        `/v1/deals?stage_id=${await dealStage('qualifying')}`,
        { cookie: acme.cookie },
      )

      expect(readList(await byStage.json()).map((deal) => deal.id)).toEqual([
        readString(first, 'id'),
      ])

      const byPerson = await client.send('GET', `/v1/deals?person_id=${ada}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byPerson.json()).map((deal) => deal.id)).toEqual([
        readString(second, 'id'),
      ])
    })

    it('matches ?q= against the deal and its company\'s name', async () => {
      await createDeal({ name: 'Engine rollout' })

      const byName = await client.send('GET', '/v1/deals?q=rollout', { cookie: acme.cookie })
      const byCompany = await client.send('GET', '/v1/deals?q=analytical', { cookie: acme.cookie })
      const byNothing = await client.send('GET', '/v1/deals?q=zeppelin', { cookie: acme.cookie })

      expect(readList(await byName.json())).toHaveLength(1)
      expect(readList(await byCompany.json())).toHaveLength(1)
      expect(readList(await byNothing.json())).toHaveLength(0)
    })

    it('keeps workspaces apart', async () => {
      const deal = await createDeal({})
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/deals', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/deals/${readString(deal, 'id')}`, {
        cookie: other.cookie,
      })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('updating', () => {
    it('changes fields and files the update', async () => {
      const deal = await createDeal({})
      const id = readString(deal, 'id')
      const response = await client.send('PATCH', `/v1/deals/${id}`, {
        body: { risks: 'Budget freeze', value_cents: 500_000 },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.risks).toBe('Budget freeze')
      expect(updated.value_cents).toBe(500_000)

      const filed = (await activitiesFor(id)).find((activity) => activity.kind === 'updated')

      expect(filed?.action).toBe('changed 2 attributes')
    })

    it('moves stage with a stage_changed trail, not a generic update', async () => {
      const deal = await createDeal({})
      const id = readString(deal, 'id')
      const proposal = await dealStage('proposal')
      const response = await client.send('PATCH', `/v1/deals/${id}`, {
        body: { stage_id: proposal },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).stage_id).toBe(proposal)

      const activities = await activitiesFor(id)
      const moved = activities.find((activity) => activity.kind === 'stage_changed')

      expect(moved?.action).toBe('moved to Proposal')
      expect(moved?.detail).toBe('Qualifying → Proposal')
      expect(activities.some((activity) => activity.kind === 'updated')).toBe(false)
    })

    it('replaces the people set, filing who joined and who left', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const deal = await createDeal({ person_ids: [ada] })
      const id = readString(deal, 'id')

      const response = await client.send('PATCH', `/v1/deals/${id}`, {
        body: { person_ids: [charles] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).person_ids).toEqual([charles])

      const activities = await activitiesFor(id)
      const unlinked = activities.find((activity) => activity.kind === 'unlinked')

      expect(unlinked?.detail).toBe('Ada Lovelace')
    })

    it('writes nothing when nothing changes', async () => {
      const deal = await createDeal({})
      const id = readString(deal, 'id')
      const response = await client.send('PATCH', `/v1/deals/${id}`, {
        body: { name: 'Engine rollout' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).updated_at).toBe(deal.updated_at)
    })

    it('refuses an owner outside the workspace', async () => {
      const deal = await createDeal({})
      const response = await client.send('PATCH', `/v1/deals/${readString(deal, 'id')}`, {
        body: { owner_id: 'mem_nowhere' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the deal and everything attached to it', async () => {
      const deal = await createDeal({})
      const id = readString(deal, 'id')

      await client.send('POST', '/v1/notes', {
        body: { target_type: 'deal', target_id: id, body: 'Worth remembering' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/plan_items', {
        body: { target_type: 'deal', target_id: id, date: '2026-09-01', title: 'Send proposal' },
        cookie: acme.cookie,
      })

      const response = await client.send('DELETE', `/v1/deals/${id}`, { cookie: acme.cookie })

      expect(response.status).toBe(204)
      expect((await client.send('GET', `/v1/deals/${id}`, { cookie: acme.cookie })).status).toBe(404)

      const remaining = await database.db
        .select({ id: planItems.id })
        .from(planItems)
        .where(eq(planItems.targetId, id))

      expect(remaining).toHaveLength(0)
    })
  })
})

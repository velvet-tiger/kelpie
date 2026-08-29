import { partnershipSchema } from '@kelpie/schemas'
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
import { and } from 'drizzle-orm'
import { personLinks } from '../people/schema.ts'

/** `/v1/partnerships` against real Postgres. Ongoing relationships: CRUD, stage moves, key people. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('partnerships', () => {
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
    companyId = await createCompany('Segment')
  })

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function partnershipStage(slug: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=partnership', { cookie })
    const found = readList(await response.json()).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No partnership stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  async function createPartnership(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/partnerships', {
      body: { name: 'Segment integration', company_id: companyId, ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function activitiesFor(partnershipId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=partnership&target_id=${partnershipId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('creating', () => {
    it('creates a partnership from a name and a company, with honest defaults', async () => {
      const partnership = await createPartnership({})

      expect(partnership.id).toMatch(/^prt_/u)
      expect(partnership.name).toBe('Segment integration')
      expect(partnership.company_id).toBe(companyId)
      expect(partnership.stage_id).toBe(await partnershipStage('exploring'))
      expect(partnership.kind).toBe('')
      expect(partnership.next_touchpoint).toBeNull()
      expect(partnership.owner_id).toMatch(/^mem_/u)
      expect(partnership.goals).toBe('')
      expect(partnership.success_looks_like).toBe('')
      expect(partnership.person_ids).toEqual([])
      expect(partnership.summary).toBe('')
      expect(partnership.tags).toEqual([])
    })

    it("files the creation on the partnership's timeline", async () => {
      const partnership = await createPartnership({})
      const activities = await activitiesFor(readString(partnership, 'id'))

      expect(activities.some((activity) => activity.action === 'created Partnership')).toBe(true)
    })

    it('links key people and names each on the timeline', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const partnership = await createPartnership({ person_ids: [ada, charles] })

      expect(partnership.person_ids).toEqual([ada, charles].sort())

      const linked = (await activitiesFor(readString(partnership, 'id'))).filter(
        (activity) => activity.kind === 'linked',
      )

      expect(linked.map((activity) => activity.detail).sort()).toEqual([
        'Ada Lovelace',
        'Charles Babbage',
      ])
    })

    it('takes kind, stage, touchpoint, and the agent fields', async () => {
      const partnership = await createPartnership({
        kind: 'Integration',
        stage_id: await partnershipStage('active'),
        next_touchpoint: '2026-09-12',
        goals: 'Ship the shared connector.',
        success_looks_like: '50 joint customers.',
        summary: 'Deep product partnership.',
        tags: ['integration', 'gtm'],
      })

      expect(partnership.kind).toBe('Integration')
      expect(partnership.stage_id).toBe(await partnershipStage('active'))
      expect(partnership.next_touchpoint).toBe('2026-09-12')
      expect(partnership.goals).toBe('Ship the shared connector.')
      expect(partnership.success_looks_like).toBe('50 joint customers.')
      expect(partnership.summary).toBe('Deep product partnership.')
      expect(partnership.tags).toEqual(['integration', 'gtm'])
    })

    it('refuses a stage from another pipeline with 422', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=deal', {
        cookie: acme.cookie,
      })
      const dealStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/partnerships', {
        body: { name: 'Wrong board', company_id: companyId, stage_id: dealStage },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('reports references outside the workspace as missing', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignCompany = await createCompany('Foreign Co', other.cookie)
      const foreignPerson = await createPerson('Grace Hopper', other.cookie)

      const byCompany = await client.send('POST', '/v1/partnerships', {
        body: { name: 'Nope', company_id: foreignCompany },
        cookie: acme.cookie,
      })
      const byPerson = await client.send('POST', '/v1/partnerships', {
        body: { name: 'Nope', company_id: companyId, person_ids: [foreignPerson] },
        cookie: acme.cookie,
      })

      expect(byCompany.status).toBe(404)
      expect(byPerson.status).toBe(404)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { name: 'X' },
        { name: '', company_id: companyId },
        { name: 'X', company_id: companyId, next_touchpoint: '2026-02-30' },
        { name: 'X', company_id: companyId, health: 'good' },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/partnerships', {
          body,
          cookie: acme.cookie,
        })

        expect(response.status).toBe(422)
      }
    })
  })

  describe('listing', () => {
    it('filters by kind, company, stage, and person', async () => {
      const ada = await createPerson('Ada Lovelace')
      const otherCompany = await createCompany('Vercel')
      const integration = await createPartnership({
        name: 'Segment integration',
        kind: 'Integration',
        person_ids: [ada],
      })
      const comarketing = await createPartnership({
        name: 'Vercel co-marketing',
        kind: 'Co-marketing',
        company_id: otherCompany,
        stage_id: await partnershipStage('active'),
      })

      const byKind = await client.send('GET', '/v1/partnerships?kind=Integration', {
        cookie: acme.cookie,
      })

      expect(readList(await byKind.json()).map((item) => item.id)).toEqual([
        readString(integration, 'id'),
      ])

      const byCompany = await client.send('GET', `/v1/partnerships?company_id=${otherCompany}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byCompany.json()).map((item) => item.id)).toEqual([
        readString(comarketing, 'id'),
      ])

      const byStage = await client.send(
        'GET',
        `/v1/partnerships?stage_id=${await partnershipStage('exploring')}`,
        { cookie: acme.cookie },
      )

      expect(readList(await byStage.json()).map((item) => item.id)).toEqual([
        readString(integration, 'id'),
      ])

      const byPerson = await client.send('GET', `/v1/partnerships?person_id=${ada}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byPerson.json()).map((item) => item.id)).toEqual([
        readString(integration, 'id'),
      ])
    })

    it('matches ?q= against the name, kind, and company name', async () => {
      await createPartnership({ name: 'Warehouse sync', kind: 'Integration' })

      const byName = await client.send('GET', '/v1/partnerships?q=warehouse', {
        cookie: acme.cookie,
      })
      const byKind = await client.send('GET', '/v1/partnerships?q=integration', {
        cookie: acme.cookie,
      })
      const byCompany = await client.send('GET', '/v1/partnerships?q=segment', {
        cookie: acme.cookie,
      })
      const byNothing = await client.send('GET', '/v1/partnerships?q=zeppelin', {
        cookie: acme.cookie,
      })

      expect(readList(await byName.json())).toHaveLength(1)
      expect(readList(await byKind.json())).toHaveLength(1)
      expect(readList(await byCompany.json())).toHaveLength(1)
      expect(readList(await byNothing.json())).toHaveLength(0)
    })

    it('keeps workspaces apart', async () => {
      const partnership = await createPartnership({})
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/partnerships', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/partnerships/${readString(partnership, 'id')}`, {
        cookie: other.cookie,
      })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('updating', () => {
    it('changes fields and files the update', async () => {
      const partnership = await createPartnership({})
      const id = readString(partnership, 'id')
      const response = await client.send('PATCH', `/v1/partnerships/${id}`, {
        body: { kind: 'Co-marketing', goals: 'Joint webinar series.' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.kind).toBe('Co-marketing')
      expect(updated.goals).toBe('Joint webinar series.')

      const filed = (await activitiesFor(id)).find((activity) => activity.kind === 'updated')

      expect(filed?.action).toBe('changed 2 attributes')
    })

    it('moves stage with a stage_changed trail, not a generic update', async () => {
      const partnership = await createPartnership({})
      const id = readString(partnership, 'id')
      const active = await partnershipStage('active')
      const response = await client.send('PATCH', `/v1/partnerships/${id}`, {
        body: { stage_id: active },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).stage_id).toBe(active)

      const activities = await activitiesFor(id)
      const moved = activities.find((activity) => activity.kind === 'stage_changed')

      expect(moved?.action).toBe('moved to Active')
      expect(moved?.detail).toBe('Exploring → Active')
      expect(activities.some((activity) => activity.kind === 'updated')).toBe(false)
    })

    it('replaces the people set, filing who joined and who left', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const partnership = await createPartnership({ person_ids: [ada] })
      const id = readString(partnership, 'id')

      const response = await client.send('PATCH', `/v1/partnerships/${id}`, {
        body: { person_ids: [charles] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).person_ids).toEqual([charles])

      const activities = await activitiesFor(id)
      const unlinked = activities.find((activity) => activity.kind === 'unlinked')

      expect(unlinked?.detail).toBe('Ada Lovelace')
    })

    it('clears the touchpoint with null', async () => {
      const partnership = await createPartnership({ next_touchpoint: '2026-09-12' })
      const response = await client.send(
        'PATCH',
        `/v1/partnerships/${readString(partnership, 'id')}`,
        { body: { next_touchpoint: null }, cookie: acme.cookie },
      )

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).next_touchpoint).toBeNull()
    })

    it('writes nothing when nothing changes', async () => {
      const partnership = await createPartnership({})
      const id = readString(partnership, 'id')
      const response = await client.send('PATCH', `/v1/partnerships/${id}`, {
        body: { name: 'Segment integration' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).updated_at).toBe(partnership.updated_at)
    })

    it('refuses an owner outside the workspace', async () => {
      const partnership = await createPartnership({})
      const response = await client.send(
        'PATCH',
        `/v1/partnerships/${readString(partnership, 'id')}`,
        { body: { owner_id: 'mem_nowhere' }, cookie: acme.cookie },
      )

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the partnership and everything attached to it', async () => {
      const ada = await createPerson('Ada Lovelace')
      const partnership = await createPartnership({ person_ids: [ada] })
      const id = readString(partnership, 'id')

      await client.send('POST', '/v1/notes', {
        body: { target_type: 'partnership', target_id: id, body: 'Worth remembering' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/plan_items', {
        body: {
          target_type: 'partnership',
          target_id: id,
          date: '2026-09-01',
          title: 'Quarterly sync',
        },
        cookie: acme.cookie,
      })

      const response = await client.send('DELETE', `/v1/partnerships/${id}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)
      expect(
        (await client.send('GET', `/v1/partnerships/${id}`, { cookie: acme.cookie })).status,
      ).toBe(404)

      const remainingPlans = await database.db
        .select({ id: planItems.id })
        .from(planItems)
        .where(eq(planItems.targetId, id))
      const remainingLinks = await database.db
        .select({ personId: personLinks.personId })
        .from(personLinks)
        .where(and(eq(personLinks.targetType, 'partnership'), eq(personLinks.targetId, id)))

      expect(remainingPlans).toHaveLength(0)
      expect(remainingLinks).toHaveLength(0)
    })
  })

  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const ada = await createPerson('Ada Lovelace')
      const created = await createPartnership({
        kind: 'Integration',
        stage_id: await partnershipStage('active'),
        next_touchpoint: '2026-09-12',
        goals: 'Ship the shared connector.',
        success_looks_like: '50 joint customers.',
        person_ids: [ada],
        summary: 'Deep product partnership.',
        tags: ['integration'],
      })

      expect(partnershipSchema.parse(created).name).toBe('Segment integration')

      const detail = await client.send('GET', `/v1/partnerships/${String(created.id)}`, {
        cookie: acme.cookie,
      })
      expect(partnershipSchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/partnerships', { cookie: acme.cookie })
      expect(
        readList(await listed.json()).map((item) => partnershipSchema.parse(item).id),
      ).toContain(created.id)

      const patched = await client.send('PATCH', `/v1/partnerships/${String(created.id)}`, {
        body: { summary: 'Updated' },
        cookie: acme.cookie,
      })
      expect(partnershipSchema.parse(readRecord(await patched.json())).summary).toBe('Updated')
    })
  })
})

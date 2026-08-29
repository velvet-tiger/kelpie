import { opportunitySchema } from '@kelpie/schemas'
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

/** `/v1/opportunities` against real Postgres. The non-sales pipeline: CRUD and stage moves. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('opportunities', () => {
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

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function opportunityStage(slug: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=opportunity', { cookie })
    const found = readList(await response.json()).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No opportunity stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  async function createOpportunity(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/opportunities', {
      body: { name: 'YC W27 application', ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function activitiesFor(opportunityId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=opportunity&target_id=${opportunityId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('creating', () => {
    it('creates an opportunity from a name alone, with honest defaults', async () => {
      const opportunity = await createOpportunity({})

      expect(opportunity.id).toMatch(/^opp_/u)
      expect(opportunity.name).toBe('YC W27 application')
      expect(opportunity.kind).toBe('')
      expect(opportunity.stage_id).toBe(await opportunityStage('identified'))
      expect(opportunity.company_id).toBeNull()
      expect(opportunity.owner_id).toMatch(/^mem_/u)
      expect(opportunity.expected_close).toBeNull()
      expect(opportunity.summary).toBe('')
      expect(opportunity.tags).toEqual([])
      expect(opportunity.person_ids).toEqual([])
    })

    it('files the creation on the opportunity\'s timeline', async () => {
      const opportunity = await createOpportunity({})
      const activities = await activitiesFor(readString(opportunity, 'id'))

      expect(activities.some((activity) => activity.action === 'created Opportunity')).toBe(true)
    })

    it('takes kind, company, stage, target date, and the agent fields', async () => {
      const companyId = await createCompany('Y Combinator')
      const opportunity = await createOpportunity({
        kind: 'Accelerator',
        company_id: companyId,
        stage_id: await opportunityStage('applied'),
        expected_close: '2026-09-12',
        summary: 'Application submitted.',
        tags: ['accelerator', 'fundraising'],
      })

      expect(opportunity.kind).toBe('Accelerator')
      expect(opportunity.company_id).toBe(companyId)
      expect(opportunity.stage_id).toBe(await opportunityStage('applied'))
      expect(opportunity.expected_close).toBe('2026-09-12')
      expect(opportunity.summary).toBe('Application submitted.')
      expect(opportunity.tags).toEqual(['accelerator', 'fundraising'])
    })

    it('refuses a stage from another pipeline with 422', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=deal', {
        cookie: acme.cookie,
      })
      const dealStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Wrong board', stage_id: dealStage },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('reports references outside the workspace as missing', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignCompany = await createCompany('Foreign Co', other.cookie)

      const response = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Nope', company_id: foreignCompany },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { name: '' },
        { name: 'X', expected_close: '2026-02-30' },
        { name: 'X', next_step: 'apply' },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/opportunities', {
          body,
          cookie: acme.cookie,
        })

        expect(response.status).toBe(422)
      }
    })
  })

  describe('listing', () => {
    it('filters by kind, company, and stage', async () => {
      const companyId = await createCompany('Y Combinator')
      const grant = await createOpportunity({ name: 'ARC grant', kind: 'Grant' })
      const accelerator = await createOpportunity({
        name: 'YC application',
        kind: 'Accelerator',
        company_id: companyId,
        stage_id: await opportunityStage('applied'),
      })

      const byKind = await client.send('GET', '/v1/opportunities?kind=Grant', {
        cookie: acme.cookie,
      })

      expect(readList(await byKind.json()).map((item) => item.id)).toEqual([
        readString(grant, 'id'),
      ])

      const byCompany = await client.send(`GET`, `/v1/opportunities?company_id=${companyId}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byCompany.json()).map((item) => item.id)).toEqual([
        readString(accelerator, 'id'),
      ])

      const byStage = await client.send(
        'GET',
        `/v1/opportunities?stage_id=${await opportunityStage('identified')}`,
        { cookie: acme.cookie },
      )

      expect(readList(await byStage.json()).map((item) => item.id)).toEqual([
        readString(grant, 'id'),
      ])
    })

    it('matches ?q= against the name, kind, and company name', async () => {
      const companyId = await createCompany('Y Combinator')
      await createOpportunity({ name: 'W27 application', kind: 'Accelerator', company_id: companyId })

      const byName = await client.send('GET', '/v1/opportunities?q=w27', { cookie: acme.cookie })
      const byKind = await client.send('GET', '/v1/opportunities?q=accelerator', {
        cookie: acme.cookie,
      })
      const byCompany = await client.send('GET', '/v1/opportunities?q=combinator', {
        cookie: acme.cookie,
      })
      const byNothing = await client.send('GET', '/v1/opportunities?q=zeppelin', {
        cookie: acme.cookie,
      })

      expect(readList(await byName.json())).toHaveLength(1)
      expect(readList(await byKind.json())).toHaveLength(1)
      expect(readList(await byCompany.json())).toHaveLength(1)
      expect(readList(await byNothing.json())).toHaveLength(0)
    })

    it('keeps workspaces apart', async () => {
      const opportunity = await createOpportunity({})
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/opportunities', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/opportunities/${readString(opportunity, 'id')}`, {
        cookie: other.cookie,
      })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('people', () => {
    async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
      const response = await client.send('POST', '/v1/people', {
        body: { name, email: `${name.replace(/\W/gu, '.').toLowerCase()}@example.com` },
        cookie,
      })

      return readString(await response.json(), 'id')
    }

    it('links people on create and files a "linked" activity per person', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const opportunity = await createOpportunity({ person_ids: [ada, charles] })

      expect(opportunity.person_ids).toEqual([ada, charles].sort())

      const linked = (await activitiesFor(readString(opportunity, 'id'))).filter(
        (activity) => activity.kind === 'linked',
      )

      expect(linked.map((activity) => activity.detail).sort()).toEqual([
        'Ada Lovelace',
        'Charles Babbage',
      ])
    })

    it('reports an unknown person as 404', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignPerson = await createPerson('Grace Hopper', other.cookie)

      const response = await client.send('POST', '/v1/opportunities', {
        body: { name: 'Nope', person_ids: [foreignPerson] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('replaces the people set, filing who joined and who left', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const opportunity = await createOpportunity({ person_ids: [ada] })
      const id = readString(opportunity, 'id')

      const response = await client.send('PATCH', `/v1/opportunities/${id}`, {
        body: { person_ids: [charles] },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.person_ids).toEqual([charles])

      const activities = await activitiesFor(id)
      const linked = activities.filter((activity) => activity.kind === 'linked')
      const unlinked = activities.filter((activity) => activity.kind === 'unlinked')

      expect(linked.map((activity) => activity.detail).sort()).toEqual([
        'Ada Lovelace',
        'Charles Babbage',
      ])
      expect(unlinked.map((activity) => activity.detail)).toEqual(['Ada Lovelace'])
    })

    it('filters ?person_id= by any of the ids', async () => {
      const ada = await createPerson('Ada Lovelace')
      const charles = await createPerson('Charles Babbage')
      const first = await createOpportunity({ name: 'ARC grant', person_ids: [ada] })
      const second = await createOpportunity({ name: 'YC application', person_ids: [charles] })

      const response = await client.send('GET', `/v1/opportunities?person_id=${ada}`, {
        cookie: acme.cookie,
      })
      const items = readList(await response.json())

      expect(items.map((item) => item.id)).toEqual([readString(first, 'id')])
      expect(items.map((item) => item.id)).not.toContain(readString(second, 'id'))
    })
  })

  describe('updating', () => {
    it('changes fields and files the update', async () => {
      const opportunity = await createOpportunity({})
      const id = readString(opportunity, 'id')
      const response = await client.send('PATCH', `/v1/opportunities/${id}`, {
        body: { kind: 'Grant', summary: 'Interview scheduled.' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.kind).toBe('Grant')
      expect(updated.summary).toBe('Interview scheduled.')

      const filed = (await activitiesFor(id)).find((activity) => activity.kind === 'updated')

      expect(filed?.action).toBe('changed 2 attributes')
    })

    it('moves stage with a stage_changed trail, not a generic update', async () => {
      const opportunity = await createOpportunity({})
      const id = readString(opportunity, 'id')
      const applied = await opportunityStage('applied')
      const response = await client.send('PATCH', `/v1/opportunities/${id}`, {
        body: { stage_id: applied },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).stage_id).toBe(applied)

      const activities = await activitiesFor(id)
      const moved = activities.find((activity) => activity.kind === 'stage_changed')

      expect(moved?.action).toBe('moved to Applied')
      expect(moved?.detail).toBe('Identified → Applied')
      expect(activities.some((activity) => activity.kind === 'updated')).toBe(false)
    })

    it('clears the company with null', async () => {
      const companyId = await createCompany('Y Combinator')
      const opportunity = await createOpportunity({ company_id: companyId })
      const response = await client.send(
        'PATCH',
        `/v1/opportunities/${readString(opportunity, 'id')}`,
        { body: { company_id: null }, cookie: acme.cookie },
      )

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).company_id).toBeNull()
    })

    it('writes nothing when nothing changes', async () => {
      const opportunity = await createOpportunity({})
      const id = readString(opportunity, 'id')
      const response = await client.send('PATCH', `/v1/opportunities/${id}`, {
        body: { name: 'YC W27 application' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).updated_at).toBe(opportunity.updated_at)
    })

    it('refuses an owner outside the workspace', async () => {
      const opportunity = await createOpportunity({})
      const response = await client.send(
        'PATCH',
        `/v1/opportunities/${readString(opportunity, 'id')}`,
        { body: { owner_id: 'mem_nowhere' }, cookie: acme.cookie },
      )

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the opportunity and everything attached to it', async () => {
      const opportunity = await createOpportunity({})
      const id = readString(opportunity, 'id')

      await client.send('POST', '/v1/notes', {
        body: { target_type: 'opportunity', target_id: id, body: 'Worth remembering' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/plan_items', {
        body: {
          target_type: 'opportunity',
          target_id: id,
          date: '2026-09-01',
          title: 'Submit application',
        },
        cookie: acme.cookie,
      })

      const response = await client.send('DELETE', `/v1/opportunities/${id}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)
      expect(
        (await client.send('GET', `/v1/opportunities/${id}`, { cookie: acme.cookie })).status,
      ).toBe(404)

      const remaining = await database.db
        .select({ id: planItems.id })
        .from(planItems)
        .where(eq(planItems.targetId, id))

      expect(remaining).toHaveLength(0)
    })
  })

  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const companyId = await createCompany('Y Combinator')
      const created = await createOpportunity({
        kind: 'Accelerator',
        company_id: companyId,
        stage_id: await opportunityStage('applied'),
        expected_close: '2026-09-12',
        summary: 'Application submitted.',
        tags: ['accelerator'],
      })

      expect(opportunitySchema.parse(created).name).toBe('YC W27 application')

      const detail = await client.send('GET', `/v1/opportunities/${String(created.id)}`, {
        cookie: acme.cookie,
      })
      expect(opportunitySchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/opportunities', { cookie: acme.cookie })
      expect(
        readList(await listed.json()).map((item) => opportunitySchema.parse(item).id),
      ).toContain(created.id)

      const patched = await client.send('PATCH', `/v1/opportunities/${String(created.id)}`, {
        body: { summary: 'Updated' },
        cookie: acme.cookie,
      })
      expect(opportunitySchema.parse(readRecord(await patched.json())).summary).toBe('Updated')
    })
  })
})

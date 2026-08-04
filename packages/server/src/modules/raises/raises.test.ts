import { raiseSchema } from '@kelpie/schemas'
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
import { raisePeople } from './schema.ts'

/** `/v1/raises` against real Postgres. Fundraising processes: CRUD, stage moves, key people. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('raises', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let firmId: string

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
    client = createTestClient(harness.app)
    acme = await client.owner()
    firmId = await createCompany('Cascade Ventures')
  })

  async function createCompany(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function createPerson(name: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie })

    return readString(await response.json(), 'id')
  }

  async function raiseStage(slug: string, cookie = acme.cookie): Promise<string> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=raise', { cookie })
    const found = readList(await response.json()).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No raise stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  async function createRaise(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/raises', {
      body: { name: 'Cascade seed', company_id: firmId, ...body },
      cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function activitiesFor(raiseId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=raise&target_id=${raiseId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('creating', () => {
    it('creates a raise from a name and a firm, with honest defaults', async () => {
      const raise = await createRaise({})

      expect(raise.id).toMatch(/^rse_/u)
      expect(raise.name).toBe('Cascade seed')
      expect(raise.company_id).toBe(firmId)
      expect(raise.stage_id).toBe(await raiseStage('researching'))
      expect(raise.check_size_cents).toBeNull()
      expect(raise.currency).toBe('USD')
      expect(raise.thesis_fit).toBe('')
      expect(raise.pass_reason).toBeNull()
      expect(raise.owner_id).toMatch(/^mem_/u)
      expect(raise.expected_close).toBeNull()
      expect(raise.person_ids).toEqual([])
      expect(raise.summary).toBe('')
      expect(raise.tags).toEqual([])
    })

    it("files the creation on the raise's timeline", async () => {
      const raise = await createRaise({})
      const activities = await activitiesFor(readString(raise, 'id'))

      expect(activities.some((activity) => activity.action === 'created Raise')).toBe(true)
    })

    it('links key people and names each on the timeline', async () => {
      const elena = await createPerson('Elena Sokolova')
      const marcus = await createPerson('Marcus Webb')
      const raise = await createRaise({ person_ids: [elena, marcus] })

      expect(raise.person_ids).toEqual([elena, marcus].sort())

      const linked = (await activitiesFor(readString(raise, 'id'))).filter(
        (activity) => activity.kind === 'linked',
      )

      expect(linked.map((activity) => activity.detail).sort()).toEqual([
        'Elena Sokolova',
        'Marcus Webb',
      ])
    })

    it('takes the check size, stage, thesis, and the agent fields', async () => {
      const raise = await createRaise({
        stage_id: await raiseStage('diligence'),
        check_size_cents: 150_000_000,
        currency: 'EUR',
        thesis_fit: 'B2B infra, seed to A. Strong fit.',
        expected_close: '2026-11-30',
        summary: 'Warm path via Elena.',
        tags: ['seed', 'lead'],
      })

      expect(raise.stage_id).toBe(await raiseStage('diligence'))
      expect(raise.check_size_cents).toBe(150_000_000)
      expect(raise.currency).toBe('EUR')
      expect(raise.thesis_fit).toBe('B2B infra, seed to A. Strong fit.')
      expect(raise.expected_close).toBe('2026-11-30')
      expect(raise.summary).toBe('Warm path via Elena.')
      expect(raise.tags).toEqual(['seed', 'lead'])
    })

    it('refuses a stage from another pipeline with 422', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=deal', {
        cookie: acme.cookie,
      })
      const dealStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/raises', {
        body: { name: 'Wrong board', company_id: firmId, stage_id: dealStage },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('reports references outside the workspace as missing', async () => {
      const other = await client.owner('grace@example.com', 'other')
      const foreignFirm = await createCompany('Foreign Capital', other.cookie)
      const foreignPerson = await createPerson('Grace Hopper', other.cookie)

      const byFirm = await client.send('POST', '/v1/raises', {
        body: { name: 'Nope', company_id: foreignFirm },
        cookie: acme.cookie,
      })
      const byPerson = await client.send('POST', '/v1/raises', {
        body: { name: 'Nope', company_id: firmId, person_ids: [foreignPerson] },
        cookie: acme.cookie,
      })

      expect(byFirm.status).toBe(404)
      expect(byPerson.status).toBe(404)
    })

    it('refuses malformed values with 422', async () => {
      const cases: Record<string, unknown>[] = [
        {},
        { name: 'X' },
        { name: '', company_id: firmId },
        { name: 'X', company_id: firmId, check_size_cents: -1 },
        { name: 'X', company_id: firmId, check_size_cents: 1.5 },
        { name: 'X', company_id: firmId, currency: 'euros' },
        { name: 'X', company_id: firmId, expected_close: '2026-02-30' },
        { name: 'X', company_id: firmId, pass_reason: '' },
        { name: 'X', company_id: firmId, target_raise: 5_000_000 },
      ]

      for (const body of cases) {
        const response = await client.send('POST', '/v1/raises', { body, cookie: acme.cookie })

        expect(response.status).toBe(422)
      }
    })
  })

  describe('listing', () => {
    it('filters by firm, stage, and person', async () => {
      const elena = await createPerson('Elena Sokolova')
      const otherFirm = await createCompany('Meridian Partners')
      const cascade = await createRaise({ name: 'Cascade seed', person_ids: [elena] })
      const meridian = await createRaise({
        name: 'Meridian seed',
        company_id: otherFirm,
        stage_id: await raiseStage('term_sheet'),
      })

      const byFirm = await client.send('GET', `/v1/raises?company_id=${otherFirm}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byFirm.json()).map((item) => item.id)).toEqual([
        readString(meridian, 'id'),
      ])

      const byStage = await client.send(
        'GET',
        `/v1/raises?stage_id=${await raiseStage('researching')}`,
        { cookie: acme.cookie },
      )

      expect(readList(await byStage.json()).map((item) => item.id)).toEqual([
        readString(cascade, 'id'),
      ])

      const byPerson = await client.send('GET', `/v1/raises?person_id=${elena}`, {
        cookie: acme.cookie,
      })

      expect(readList(await byPerson.json()).map((item) => item.id)).toEqual([
        readString(cascade, 'id'),
      ])
    })

    it("matches ?q= against the name, summary, and the firm's name", async () => {
      await createRaise({ name: 'Series A process', summary: 'Warm path via Elena.' })

      const byName = await client.send('GET', '/v1/raises?q=series', { cookie: acme.cookie })
      const bySummary = await client.send('GET', '/v1/raises?q=warm+path', { cookie: acme.cookie })
      const byFirm = await client.send('GET', '/v1/raises?q=cascade', { cookie: acme.cookie })
      const byNothing = await client.send('GET', '/v1/raises?q=zeppelin', { cookie: acme.cookie })

      expect(readList(await byName.json())).toHaveLength(1)
      expect(readList(await bySummary.json())).toHaveLength(1)
      expect(readList(await byFirm.json())).toHaveLength(1)
      expect(readList(await byNothing.json())).toHaveLength(0)
    })

    it('keeps workspaces apart', async () => {
      const raise = await createRaise({})
      const other = await client.owner('grace@example.com', 'other')

      const list = await client.send('GET', '/v1/raises', { cookie: other.cookie })
      const get = await client.send('GET', `/v1/raises/${readString(raise, 'id')}`, {
        cookie: other.cookie,
      })

      expect(readList(await list.json())).toHaveLength(0)
      expect(get.status).toBe(404)
    })
  })

  describe('updating', () => {
    it('changes fields and files the update', async () => {
      const raise = await createRaise({})
      const id = readString(raise, 'id')
      const response = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { check_size_cents: 50_000_000, thesis_fit: 'Fits the fund thesis.' },
        cookie: acme.cookie,
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.check_size_cents).toBe(50_000_000)
      expect(updated.thesis_fit).toBe('Fits the fund thesis.')

      const filed = (await activitiesFor(id)).find((activity) => activity.kind === 'updated')

      expect(filed?.action).toBe('changed 2 attributes')
    })

    it('moves stage with a stage_changed trail, not a generic update', async () => {
      const raise = await createRaise({})
      const id = readString(raise, 'id')
      const diligence = await raiseStage('diligence')
      const response = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { stage_id: diligence },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).stage_id).toBe(diligence)

      const activities = await activitiesFor(id)
      const moved = activities.find((activity) => activity.kind === 'stage_changed')

      expect(moved?.action).toBe('moved to Diligence')
      expect(moved?.detail).toBe('Researching → Diligence')
      expect(activities.some((activity) => activity.kind === 'updated')).toBe(false)
    })

    it('records the pass reason and clears it with null', async () => {
      const raise = await createRaise({})
      const id = readString(raise, 'id')

      const passed = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { stage_id: await raiseStage('passed'), pass_reason: 'Too early for the fund.' },
        cookie: acme.cookie,
      })

      expect(passed.status).toBe(200)
      expect(readRecord(await passed.json()).pass_reason).toBe('Too early for the fund.')

      const cleared = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { pass_reason: null },
        cookie: acme.cookie,
      })

      expect(cleared.status).toBe(200)
      expect(readRecord(await cleared.json()).pass_reason).toBeNull()
    })

    it('replaces the people set, filing who joined and who left', async () => {
      const elena = await createPerson('Elena Sokolova')
      const marcus = await createPerson('Marcus Webb')
      const raise = await createRaise({ person_ids: [elena] })
      const id = readString(raise, 'id')

      const response = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { person_ids: [marcus] },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).person_ids).toEqual([marcus])

      const activities = await activitiesFor(id)
      const unlinked = activities.find((activity) => activity.kind === 'unlinked')

      expect(unlinked?.detail).toBe('Elena Sokolova')
    })

    it('writes nothing when nothing changes', async () => {
      const raise = await createRaise({})
      const id = readString(raise, 'id')
      const response = await client.send('PATCH', `/v1/raises/${id}`, {
        body: { name: 'Cascade seed' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).updated_at).toBe(raise.updated_at)
    })

    it('refuses an owner outside the workspace', async () => {
      const raise = await createRaise({})
      const response = await client.send('PATCH', `/v1/raises/${readString(raise, 'id')}`, {
        body: { owner_id: 'mem_nowhere' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the raise and everything attached to it', async () => {
      const elena = await createPerson('Elena Sokolova')
      const raise = await createRaise({ person_ids: [elena] })
      const id = readString(raise, 'id')

      await client.send('POST', '/v1/notes', {
        body: { target_type: 'raise', target_id: id, body: 'Partner meeting notes' },
        cookie: acme.cookie,
      })
      await client.send('POST', '/v1/plan_items', {
        body: { target_type: 'raise', target_id: id, date: '2026-09-01', title: 'Send metrics' },
        cookie: acme.cookie,
      })

      const response = await client.send('DELETE', `/v1/raises/${id}`, { cookie: acme.cookie })

      expect(response.status).toBe(204)
      expect((await client.send('GET', `/v1/raises/${id}`, { cookie: acme.cookie })).status).toBe(
        404,
      )

      const remainingPlans = await database.db
        .select({ id: planItems.id })
        .from(planItems)
        .where(eq(planItems.targetId, id))
      const remainingLinks = await database.db
        .select({ personId: raisePeople.personId })
        .from(raisePeople)
        .where(eq(raisePeople.raiseId, id))

      expect(remainingPlans).toHaveLength(0)
      expect(remainingLinks).toHaveLength(0)
    })
  })

  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const elena = await createPerson('Elena Sokolova')
      const created = await createRaise({
        stage_id: await raiseStage('meeting'),
        check_size_cents: 150_000_000,
        thesis_fit: 'B2B infra, seed to A.',
        expected_close: '2026-11-30',
        person_ids: [elena],
        summary: 'Warm path via Elena.',
        tags: ['seed'],
      })

      expect(raiseSchema.parse(created).name).toBe('Cascade seed')

      const detail = await client.send('GET', `/v1/raises/${String(created.id)}`, {
        cookie: acme.cookie,
      })
      expect(raiseSchema.parse(readRecord(await detail.json())).id).toBe(created.id)

      const listed = await client.send('GET', '/v1/raises', { cookie: acme.cookie })
      expect(readList(await listed.json()).map((item) => raiseSchema.parse(item).id)).toContain(
        created.id,
      )

      const patched = await client.send('PATCH', `/v1/raises/${String(created.id)}`, {
        body: { summary: 'Updated' },
        cookie: acme.cookie,
      })
      expect(raiseSchema.parse(readRecord(await patched.json())).summary).toBe('Updated')
    })
  })
})

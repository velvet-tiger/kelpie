import { planItemSchema } from '@kelpie/schemas'
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

/**
 * `/v1/plan_items` against real Postgres.
 *
 * A plan item is the dated next step on a pipeline record. Deals are the only
 * pipeline with a create route today, so every target here is a deal; the other
 * three kinds are covered by the target-type validation cases.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('plan items', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let dealId: string

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  async function createDeal(name = 'Engine rollout', cookie = acme.cookie): Promise<string> {
    const company = await client.send('POST', '/v1/companies', {
      body: { name: `${name} Co` },
      cookie,
    })
    const response = await client.send('POST', '/v1/deals', {
      body: { name, company_id: readString(await company.json(), 'id') },
      cookie,
    })

    return readString(await response.json(), 'id')
  }

  function post(body: Record<string, unknown>, cookie = acme.cookie): Promise<Response> {
    return client.send('POST', '/v1/plan_items', { body, cookie })
  }

  async function createPlanItem(
    body: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await post(
      { target_type: 'deal', target_id: dealId, date: '2026-09-01', title: 'Send proposal', ...body },
      cookie,
    )

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  function list(query = '', cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/plan_items${query === '' ? '' : `?${query}`}`, { cookie })
  }

  async function titlesFrom(response: Response): Promise<string[]> {
    return readList(await response.json()).map((item) => readString(item, 'title'))
  }

  /** The owner's own membership id, the only member a fresh workspace has. */
  async function ownMemberId(): Promise<string> {
    const response = await client.send('GET', `/v1/workspaces/${acme.workspaceId}/members`, {
      cookie: acme.cookie,
    })
    const [member] = readList(await response.json())

    if (member === undefined) {
      throw new Error('A fresh workspace should have its owner as a member')
    }

    return readString(member, 'id')
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
    dealId = await createDeal()
  })

  describe('creating', () => {
    it('attaches a dated step to a deal', async () => {
      const item = await createPlanItem()

      expect(item.id).toMatch(/^plan_/u)
      expect(item.target_type).toBe('deal')
      expect(item.target_id).toBe(dealId)
      expect(item.date).toBe('2026-09-01')
      expect(item.title).toBe('Send proposal')
    })

    it('starts unassigned and to do', async () => {
      const item = await createPlanItem()

      expect(item.owner_id).toBeNull()
      expect(item.status).toBe('todo')
    })

    it('accepts an owner and a status', async () => {
      const memberId = await ownMemberId()
      const item = await createPlanItem({ owner_id: memberId, status: 'in_progress' })

      expect(item.owner_id).toBe(memberId)
      expect(item.status).toBe('in_progress')
    })

    it('answers 404 for a target that does not exist', async () => {
      const response = await post({
        target_type: 'deal',
        target_id: 'deal_nope',
        date: '2026-09-01',
        title: 'Into the void',
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for an owner outside the workspace', async () => {
      const response = await post({
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send proposal',
        owner_id: 'mem_nope',
      })

      expect(response.status).toBe(404)
    })

    it('refuses a target type no plan item attaches to', async () => {
      const response = await post({
        target_type: 'person',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Say hello',
      })

      expect(response.status).toBe(422)
    })

    it('refuses a date that does not exist', async () => {
      const response = await post({
        target_type: 'deal',
        target_id: dealId,
        date: '2026-02-30',
        title: 'Send proposal',
      })

      expect(response.status).toBe(422)
    })

    it('refuses a status outside the fixed set', async () => {
      const response = await post({
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send proposal',
        status: 'blocked',
      })

      expect(response.status).toBe(422)
    })

    it('refuses an unknown field rather than dropping it', async () => {
      const response = await post({
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send proposal',
        priority: 'high',
      })

      expect(response.status).toBe(422)
    })

    it('emits plans.plan_item.completed for a step recorded as already done', async () => {
      const completed: string[] = []

      harness.services.events.subscribe('plans.plan_item.completed', (event) => {
        completed.push(event.data.planItemId)
      })

      const item = await createPlanItem({ status: 'done' })

      await harness.services.events.drain()

      expect(completed).toEqual([item.id])
    })
  })

  describe('reading', () => {
    it('returns one item by id', async () => {
      const created = await createPlanItem()
      const response = await client.send('GET', `/v1/plan_items/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).title).toBe('Send proposal')
    })

    it('answers 404 for an item in another workspace', async () => {
      const created = await createPlanItem()
      const other = await client.owner('grace@example.com', 'other')
      const response = await client.send('GET', `/v1/plan_items/${String(created.id)}`, {
        cookie: other.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('listing', () => {
    beforeEach(async () => {
      await createPlanItem({ date: '2026-09-10', title: 'Later' })
      await createPlanItem({ date: '2026-08-01', title: 'Sooner', status: 'done' })
      await createPlanItem({ date: '2026-09-01', title: 'Middle', status: 'in_progress' })
    })

    it('reads forwards: the soonest step first', async () => {
      expect(await titlesFrom(await list())).toEqual(['Sooner', 'Middle', 'Later'])
    })

    it('filters to the steps of one record', async () => {
      const otherDeal = await createDeal('Second deal')

      await createPlanItem({ target_id: otherDeal, title: 'Elsewhere' })

      expect(await titlesFrom(await list(`target_id=${dealId}`))).toEqual([
        'Sooner',
        'Middle',
        'Later',
      ])
    })

    it('filters to the steps of several records at once', async () => {
      const otherDeal = await createDeal('Second deal')

      await createPlanItem({ target_id: otherDeal, date: '2026-08-15', title: 'Elsewhere' })

      const response = await list(`target_id=${dealId}&target_id=${otherDeal}`)

      expect(await titlesFrom(response)).toEqual(['Sooner', 'Elsewhere', 'Middle', 'Later'])
    })

    it('filters to one pipeline kind', async () => {
      expect(await titlesFrom(await list('target_type=deal'))).toHaveLength(3)
      expect(await titlesFrom(await list('target_type=partnership'))).toEqual([])
    })

    it('names the open statuses to ask for outstanding work', async () => {
      const response = await list('status=todo&status=in_progress')

      expect(await titlesFrom(response)).toEqual(['Middle', 'Later'])
    })

    it('bounds a month with from and to', async () => {
      const response = await list('from=2026-09-01&to=2026-09-30')

      expect(await titlesFrom(response)).toEqual(['Middle', 'Later'])
    })

    it('pages by cursor in date order', async () => {
      const first = await list('limit=2')
      const body = await first.json()

      expect(readList(body).map((item) => readString(item, 'title'))).toEqual(['Sooner', 'Middle'])

      const cursor = readCursor(body)

      expect(cursor).not.toBeNull()

      const second = await list(`limit=2&cursor=${encodeURIComponent(cursor ?? '')}`)

      expect(await titlesFrom(second)).toEqual(['Later'])
    })

    it('leaves another workspace out of it', async () => {
      const other = await client.owner('grace@example.com', 'other')

      expect(await titlesFrom(await list('', other.cookie))).toEqual([])
    })

    it('refuses a status filter outside the fixed set', async () => {
      expect((await list('status=blocked')).status).toBe(422)
    })

    it('refuses a target type no plan item attaches to', async () => {
      expect((await list('target_type=person')).status).toBe(422)
    })

    it('refuses a date bound that is not a date', async () => {
      expect((await list('from=september')).status).toBe(422)
      expect((await list('to=2026-02-30')).status).toBe(422)
    })

    it('refuses a sort field it does not document', async () => {
      expect((await list('sort=title')).status).toBe(422)
    })
  })

  describe('updating', () => {
    function patch(
      id: string,
      body: Record<string, unknown>,
      cookie = acme.cookie,
    ): Promise<Response> {
      return client.send('PATCH', `/v1/plan_items/${id}`, { body, cookie })
    }

    it('moves the date and rewrites the title', async () => {
      const created = await createPlanItem()
      const response = await patch(String(created.id), {
        date: '2026-09-15',
        title: 'Send revised proposal',
      })
      const updated = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(updated.date).toBe('2026-09-15')
      expect(updated.title).toBe('Send revised proposal')
    })

    it('assigns and unassigns an owner', async () => {
      const memberId = await ownMemberId()
      const created = await createPlanItem({ owner_id: memberId })
      const cleared = await patch(String(created.id), { owner_id: null })

      expect(readRecord(await cleared.json()).owner_id).toBeNull()
    })

    it('refuses to re-file an item under another record', async () => {
      const created = await createPlanItem()
      const response = await patch(String(created.id), { target_id: await createDeal('Second') })

      expect(response.status).toBe(422)
    })

    it('leaves updated_at alone when nothing changes', async () => {
      const created = await createPlanItem()
      const response = await patch(String(created.id), { title: 'Send proposal' })

      expect(readRecord(await response.json()).updated_at).toBe(created.updated_at)
    })

    it('emits plans.plan_item.completed when a step is finished', async () => {
      const completed: string[] = []

      harness.services.events.subscribe('plans.plan_item.completed', (event) => {
        completed.push(event.target.id)
      })

      const created = await createPlanItem()

      await patch(String(created.id), { status: 'done' })
      await harness.services.events.drain()

      expect(completed).toEqual([dealId])
    })

    it('stays quiet when a finished step is saved again', async () => {
      const completed: string[] = []

      harness.services.events.subscribe('plans.plan_item.completed', (event) => {
        completed.push(event.data.planItemId)
      })

      const created = await createPlanItem()

      await patch(String(created.id), { status: 'done' })
      await patch(String(created.id), { status: 'done' })
      await harness.services.events.drain()

      expect(completed).toHaveLength(1)
    })

    it('answers 404 for an item in another workspace', async () => {
      const created = await createPlanItem()
      const other = await client.owner('grace@example.com', 'other')
      const response = await patch(String(created.id), { title: 'Theirs now' }, other.cookie)

      expect(response.status).toBe(404)
    })
  })

  describe('deleting', () => {
    it('removes the item', async () => {
      const created = await createPlanItem()
      const response = await client.send('DELETE', `/v1/plan_items/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)
      expect(
        (
          await client.send('GET', `/v1/plan_items/${String(created.id)}`, { cookie: acme.cookie })
        ).status,
      ).toBe(404)
    })

    it('answers 404 for an item in another workspace', async () => {
      const created = await createPlanItem()
      const other = await client.owner('grace@example.com', 'other')
      const response = await client.send('DELETE', `/v1/plan_items/${String(created.id)}`, {
        cookie: other.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  /**
   * The client decodes with `planItemSchema`, so a field renamed here and not
   * there is a runtime failure in the browser that no server test would catch.
   */
  describe('the wire contract', () => {
    it('answers every read path with the shape @kelpie/schemas decodes', async () => {
      const memberId = await ownMemberId()
      const created = await createPlanItem({ owner_id: memberId, status: 'in_progress' })

      expect(planItemSchema.parse(created).title).toBe('Send proposal')

      const detail = await client.send('GET', `/v1/plan_items/${String(created.id)}`, {
        cookie: acme.cookie,
      })

      expect(planItemSchema.parse(readRecord(await detail.json())).ownerId).toBe(memberId)

      const listed = await list()

      expect(readList(await listed.json()).map((item) => planItemSchema.parse(item).id)).toContain(
        created.id,
      )

      const patched = await client.send('PATCH', `/v1/plan_items/${String(created.id)}`, {
        body: { status: 'done' },
        cookie: acme.cookie,
      })

      expect(planItemSchema.parse(readRecord(await patched.json())).status).toBe('done')
    })
  })
})

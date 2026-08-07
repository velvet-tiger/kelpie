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
import { addDays } from './attention.ts'

/**
 * `GET /v1/dashboard` against real Postgres.
 *
 * The clock is pinned, because every signal here is a comparison against today
 * and a suite that read the real one would drift into and out of its own windows
 * as the days passed.
 *
 * The workspace is in `Australia/Melbourne` and the pinned instant is late on a
 * UTC day, so a `today` computed from the server's own clock and one computed
 * from the workspace's zone are different dates. That is the point: the tests
 * below are written against the Melbourne day.
 */

const connectionString = testDatabaseUrl(process.env)

/** 2026-06-15 23:30 UTC is already 2026-06-16 in Melbourne. */
const PINNED_NOW = new Date('2026-06-15T23:30:00.000Z')
const TODAY = '2026-06-16'

describe.skipIf(connectionString === undefined)('dashboard', () => {
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
      services: createTestServices({ db: database.db, now: () => PINNED_NOW }),
    })
    client = createTestClient(harness.app)
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

  async function createCompany(name = 'Northwind', cookie = acme.cookie): Promise<string> {
    return readString(await create('/v1/companies', { name }, cookie), 'id')
  }

  async function createDeal(name = 'Engine rollout', extra: Record<string, unknown> = {}): Promise<string> {
    const companyId = await createCompany(`${name} Co`)

    return readString(await create('/v1/deals', { name, company_id: companyId, ...extra }), 'id')
  }

  async function createPerson(
    name: string,
    extra: Record<string, unknown> = {},
    cookie = acme.cookie,
  ): Promise<string> {
    return readString(await create('/v1/people', { name, ...extra }, cookie), 'id')
  }

  /** The workspace's stages for one pipeline, which onboarding seeded. */
  async function stageId(kind: string, slug: string): Promise<string> {
    const response = await client.send('GET', `/v1/pipeline_stages?kind=${kind}`, {
      cookie: acme.cookie,
    })
    const payload = readRecord(await response.json())
    const stages = Array.isArray(payload.data) ? payload.data : []
    const found = stages
      .map((stage) => readRecord(stage))
      .find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No ${kind} stage "${slug}" in ${JSON.stringify(stages)}`)
    }

    return readString(found, 'id')
  }

  function get(query = '', cookie = acme.cookie): Promise<Response> {
    return client.send('GET', `/v1/dashboard${query === '' ? '' : `?${query}`}`, { cookie })
  }

  async function snapshot(query = ''): Promise<Record<string, unknown>> {
    const response = await get(query)

    expect(response.status, await response.clone().text()).toBe(200)

    return readRecord(await response.json())
  }

  /** Reads one `{ total, items }` signal off the snapshot. */
  async function signal(
    key: string,
    query = '',
  ): Promise<{ total: number; items: Record<string, unknown>[] }> {
    const payload = readRecord(await snapshot(query))
    const list = readRecord(payload[key])

    if (typeof list.total !== 'number' || !Array.isArray(list.items)) {
      throw new Error(`Expected a signal at "${key}", got ${JSON.stringify(list)}`)
    }

    return { total: list.total, items: list.items.map((item) => readRecord(item)) }
  }

  function openCount(payload: Record<string, unknown>, kind: string): number {
    const pipelines = Array.isArray(payload.pipelines) ? payload.pipelines : []
    const found = pipelines.map((row) => readRecord(row)).find((row) => row.kind === kind)

    if (found === undefined || typeof found.open !== 'number') {
      throw new Error(`No open count for ${kind} in ${JSON.stringify(pipelines)}`)
    }

    return found.open
  }

  describe('access', () => {
    // Not through `get`: passing it an explicit undefined cookie would take the
    // owner's from the default parameter and prove the opposite of the point.
    it('refuses a request with no credentials', async () => {
      const response = await client.send('GET', '/v1/dashboard')

      expect(response.status).toBe(401)
    })

    it('refuses an account that has no workspace yet', async () => {
      const cookie = await client.signUp('new@example.com')
      const response = await get('', cookie)

      expect(response.status).toBe(403)
    })
  })

  describe('the empty workspace', () => {
    it('answers zeros rather than omitting the signals', async () => {
      const payload = await snapshot()

      expect(payload.today).toBe(TODAY)
      expect(payload.timezone).toBe('Australia/Melbourne')
      expect(payload.stale_contact_days).toBe(14)
      expect(payload.upcoming_days).toBe(7)
      expect(payload.generated_at).toBe(PINNED_NOW.toISOString())
      expect(openCount(payload, 'deal')).toBe(0)
      expect(await signal('overdue_plan_items')).toEqual({ total: 0, items: [] })
      expect(await signal('stale_contacts')).toEqual({ total: 0, items: [] })
      expect(payload.recent_activity).toEqual([])
      expect(payload.recent_notes).toEqual([])
      expect(payload.recent_decisions).toEqual([])
    })

    it('names every pipeline, so a caller need not know which four there are', async () => {
      const payload = await snapshot()
      const kinds = (Array.isArray(payload.pipelines) ? payload.pipelines : []).map((row) =>
        readRecord(row).kind,
      )

      expect(kinds).toEqual(['deal', 'opportunity', 'raise', 'partnership'])
    })
  })

  describe('open counts per pipeline', () => {
    it('counts records in open stages and skips the closed ones', async () => {
      await createDeal('Open one')
      await createDeal('Open two')
      await createDeal('Landed', { stage_id: await stageId('deal', 'won') })

      expect(openCount(await snapshot(), 'deal')).toBe(2)
    })

    it('counts partnerships as a pipeline of their own', async () => {
      const companyId = await createCompany('Partner Co')

      await create('/v1/partnerships', { name: 'Reseller', company_id: companyId, kind: 'reseller' })
      await create('/v1/partnerships', {
        name: 'Wound up',
        company_id: companyId,
        kind: 'reseller',
        stage_id: await stageId('partnership', 'ended'),
      })

      expect(openCount(await snapshot(), 'partnership')).toBe(1)
    })
  })

  describe('plan items', () => {
    async function planItem(date: string, title: string, extra: Record<string, unknown> = {}) {
      const dealId = await createDeal(title)

      return create('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date,
        title,
        ...extra,
      })
    }

    it('splits overdue from due soon at today', async () => {
      await planItem(addDays(TODAY, -3), 'Late follow-up')
      await planItem(TODAY, 'Due today')
      await planItem(addDays(TODAY, 7), 'Due on the last day of the window')
      await planItem(addDays(TODAY, 8), 'Beyond the window')

      const overdue = await signal('overdue_plan_items')
      const dueSoon = await signal('due_soon_plan_items')

      expect(overdue.items.map((item) => item.title)).toEqual(['Late follow-up'])
      expect(dueSoon.items.map((item) => item.title)).toEqual([
        'Due today',
        'Due on the last day of the window',
      ])
    })

    it('leaves a finished step out however late it is', async () => {
      await planItem(addDays(TODAY, -30), 'Handled', { status: 'done' })

      expect(await signal('overdue_plan_items')).toEqual({ total: 0, items: [] })
    })

    it('names the record each step is on', async () => {
      await planItem(addDays(TODAY, -1), 'Send the revised terms')

      const [item] = (await signal('overdue_plan_items')).items

      expect(item?.target_type).toBe('deal')
      expect(item?.target_name).toBe('Send the revised terms')
    })

    it('orders the overdue soonest first, so the oldest is at the top', async () => {
      await planItem(addDays(TODAY, -1), 'Yesterday')
      await planItem(addDays(TODAY, -10), 'Ten days ago')

      expect((await signal('overdue_plan_items')).items.map((item) => item.title)).toEqual([
        'Ten days ago',
        'Yesterday',
      ])
    })
  })

  describe('partnership touchpoints', () => {
    async function partnership(
      name: string,
      nextTouchpoint: string | null,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const companyId = await createCompany(`${name} Co`)

      return create('/v1/partnerships', {
        name,
        company_id: companyId,
        kind: 'reseller',
        next_touchpoint: nextTouchpoint,
        ...extra,
      })
    }

    it('takes the ones at hand and the ones already missed', async () => {
      await partnership('Missed', addDays(TODAY, -2))
      await partnership('This week', addDays(TODAY, 3))
      await partnership('Next month', addDays(TODAY, 30))
      await partnership('Unscheduled', null)

      const touchpoints = await signal('partnership_touchpoints')

      expect(touchpoints.total).toBe(2)
      expect(touchpoints.items.map((row) => [row.name, row.overdue])).toEqual([
        ['Missed', true],
        ['This week', false],
      ])
    })

    it('ignores a partnership in a closed stage', async () => {
      await partnership('Wound up', addDays(TODAY, 1), {
        stage_id: await stageId('partnership', 'ended'),
      })

      expect(await signal('partnership_touchpoints')).toEqual({ total: 0, items: [] })
    })
  })

  describe('stale contacts', () => {
    /** `at` is a `YYYY-MM-DD` read in the workspace's zone, stamped at midday there. */
    function contactedOn(day: string): string {
      return new Date(`${day}T12:00:00+10:00`).toISOString()
    }

    it('takes people last contacted more than a fortnight ago', async () => {
      await createPerson('Long gone', { last_contacted_at: contactedOn(addDays(TODAY, -30)) })
      await createPerson('Just over', { last_contacted_at: contactedOn(addDays(TODAY, -15)) })
      await createPerson('On the boundary', { last_contacted_at: contactedOn(addDays(TODAY, -14)) })
      await createPerson('Yesterday', { last_contacted_at: contactedOn(addDays(TODAY, -1)) })
      await createPerson('Never recorded')

      const stale = await signal('stale_contacts')

      expect(stale.total).toBe(2)
      expect(stale.items.map((row) => [row.name, row.days_since_contact])).toEqual([
        ['Long gone', 30],
        ['Just over', 15],
      ])
    })

    it('reads the day in the workspace zone, not the server one', async () => {
      // 2026-06-01 23:30 UTC is 2026-06-02 in Melbourne, exactly 14 days before
      // today there, so the person is fresh. Read in UTC it would be 15 days.
      await createPerson('Boundary', { last_contacted_at: '2026-06-01T23:30:00.000Z' })

      expect((await signal('stale_contacts')).total).toBe(0)
    })
  })

  describe('recent activity, notes and decisions', () => {
    it('names the record each row is about', async () => {
      const personId = await createPerson('Ada Lovelace')

      await create('/v1/notes', { target_type: 'person', target_id: personId, body: 'Met at KubeCon' })
      await create('/v1/decisions', {
        target_type: 'person',
        target_id: personId,
        body: 'Ada reviews the security section',
      })

      const payload = await snapshot()
      const notes = Array.isArray(payload.recent_notes) ? payload.recent_notes.map(readRecord) : []
      const decisions = Array.isArray(payload.recent_decisions)
        ? payload.recent_decisions.map(readRecord)
        : []
      const activity = Array.isArray(payload.recent_activity)
        ? payload.recent_activity.map(readRecord)
        : []

      expect(notes[0]?.target_name).toBe('Ada Lovelace')
      expect(decisions[0]?.target_name).toBe('Ada Lovelace')
      expect(activity.every((row) => row.target_name === 'Ada Lovelace')).toBe(true)
    })

    it('puts pinned notes first, whatever their age', async () => {
      const personId = await createPerson('Ada Lovelace')

      await create('/v1/notes', { target_type: 'person', target_id: personId, body: 'Older, pinned', pinned: true })
      await create('/v1/notes', { target_type: 'person', target_id: personId, body: 'Newer' })

      const payload = await snapshot()
      const bodies = (Array.isArray(payload.recent_notes) ? payload.recent_notes : []).map(
        (note) => readRecord(note).body,
      )

      expect(bodies).toEqual(['Older, pinned', 'Newer'])
    })
  })

  describe('limit', () => {
    it('caps the items and leaves the totals exact', async () => {
      for (const offset of [-1, -2, -3]) {
        const dealId = await createDeal(`Deal ${String(offset)}`)

        await create('/v1/plan_items', {
          target_type: 'deal',
          target_id: dealId,
          date: addDays(TODAY, offset),
          title: `Step ${String(offset)}`,
        })
      }

      const capped = await signal('overdue_plan_items', 'limit=2')

      expect(capped.total).toBe(3)
      expect(capped.items).toHaveLength(2)
    })

    it('refuses a limit outside the page-size range', async () => {
      expect((await get('limit=0')).status).toBe(422)
      expect((await get('limit=201')).status).toBe(422)
      expect((await get('limit=two')).status).toBe(422)
    })
  })

  describe('workspace scoping', () => {
    it('never reads another workspace', async () => {
      const dealId = await createDeal('Ours')

      await create('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date: addDays(TODAY, -1),
        title: 'Ours',
      })

      const other = await client.owner('other@example.com', 'other')
      const response = await get('', other.cookie)
      const payload = readRecord(await response.json())

      expect(openCount(payload, 'deal')).toBe(0)
      expect(readRecord(payload.overdue_plan_items).total).toBe(0)
    })
  })
})

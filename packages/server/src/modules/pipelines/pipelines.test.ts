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

/** `/v1/pipeline_stages` against real Postgres. The configurable board columns of the four pipelines. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('pipeline stages', () => {
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
    client = createTestClient(harness.app)
    acme = await client.owner()
  })

  async function dealStages(cookie = acme.cookie): Promise<Record<string, unknown>[]> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=deal', { cookie })

    expect(response.status).toBe(200)

    return readList(await response.json())
  }

  async function stageIdBySlug(slug: string): Promise<string> {
    const stages = await dealStages()
    const found = stages.find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No deal stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  describe('listing', () => {
    it('answers the seeded deal stages in board order', async () => {
      const stages = await dealStages()

      expect(stages.map((stage) => stage.slug)).toEqual([
        'qualifying',
        'proposal',
        'negotiation',
        'won',
        'lost',
      ])
      expect(stages.map((stage) => stage.sort_order)).toEqual([0, 1, 2, 3, 4])
      expect(stages.map((stage) => stage.open)).toEqual([true, true, true, false, false])
    })

    it('lists all four pipelines without a kind filter', async () => {
      const response = await client.send('GET', '/v1/pipeline_stages?limit=200', {
        cookie: acme.cookie,
      })
      const stages = readList(await response.json())
      const kinds = new Set(stages.map((stage) => stage.kind))

      expect(kinds).toEqual(new Set(['deal', 'opportunity', 'raise', 'partnership']))
    })

    it('refuses an unknown kind with 422', async () => {
      const response = await client.send('GET', '/v1/pipeline_stages?kind=sales', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('requires credentials', async () => {
      expect((await client.send('GET', '/v1/pipeline_stages')).status).toBe(401)
    })
  })

  describe('adding', () => {
    it('appends a new stage with a slug derived from its label', async () => {
      const response = await client.send('POST', '/v1/pipeline_stages', {
        body: { kind: 'deal', label: 'Contract Sent' },
        cookie: acme.cookie,
      })
      const stage = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(stage.id).toMatch(/^stage_/u)
      expect(stage.slug).toBe('contract_sent')
      expect(stage.label).toBe('Contract Sent')
      expect(stage.open).toBe(true)
      expect(stage.sort_order).toBe(5)
    })

    it('suffixes the slug when the label repeats', async () => {
      const response = await client.send('POST', '/v1/pipeline_stages', {
        body: { kind: 'deal', label: 'Won' },
        cookie: acme.cookie,
      })
      const stage = readRecord(await response.json())

      expect(response.status).toBe(201)
      expect(stage.slug).toBe('won_2')
    })

    it('refuses an unknown kind with 422', async () => {
      const response = await client.send('POST', '/v1/pipeline_stages', {
        body: { kind: 'sales', label: 'New' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('renaming and visibility', () => {
    it('renames the label and leaves the slug alone', async () => {
      const id = await stageIdBySlug('qualifying')
      const response = await client.send('PATCH', `/v1/pipeline_stages/${id}`, {
        body: { label: 'Discovery' },
        cookie: acme.cookie,
      })
      const stage = readRecord(await response.json())

      expect(response.status).toBe(200)
      expect(stage.label).toBe('Discovery')
      expect(stage.slug).toBe('qualifying')
    })

    it('flips the open flag', async () => {
      const id = await stageIdBySlug('negotiation')
      const response = await client.send('PATCH', `/v1/pipeline_stages/${id}`, {
        body: { open: false },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).open).toBe(false)
    })

    it('hides another workspace\'s stage as missing', async () => {
      const id = await stageIdBySlug('qualifying')
      const other = await client.owner('grace@example.com', 'other')
      const response = await client.send('PATCH', `/v1/pipeline_stages/${id}`, {
        body: { label: 'Taken over' },
        cookie: other.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('reordering', () => {
    it('moves a stage to a new position and renumbers the rest', async () => {
      const id = await stageIdBySlug('negotiation')
      const response = await client.send('PATCH', `/v1/pipeline_stages/${id}`, {
        body: { sort_order: 0 },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(200)
      expect(readRecord(await response.json()).sort_order).toBe(0)

      const stages = await dealStages()

      expect(stages.map((stage) => stage.slug)).toEqual([
        'negotiation',
        'qualifying',
        'proposal',
        'won',
        'lost',
      ])
      expect(stages.map((stage) => stage.sort_order)).toEqual([0, 1, 2, 3, 4])
    })

    it('refuses a position past the end with 422', async () => {
      const id = await stageIdBySlug('negotiation')
      const response = await client.send('PATCH', `/v1/pipeline_stages/${id}`, {
        body: { sort_order: 5 },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('removing', () => {
    async function createDealIn(stageId: string): Promise<string> {
      const company = await client.send('POST', '/v1/companies', {
        body: { name: 'Analytical Engines' },
        cookie: acme.cookie,
      })
      const companyId = readString(await company.json(), 'id')
      const deal = await client.send('POST', '/v1/deals', {
        body: { name: 'Engine rollout', company_id: companyId, stage_id: stageId },
        cookie: acme.cookie,
      })

      expect(deal.status).toBe(201)

      return readString(await deal.json(), 'id')
    }

    it('removes an empty stage and closes the gap in the order', async () => {
      const id = await stageIdBySlug('proposal')
      const response = await client.send('DELETE', `/v1/pipeline_stages/${id}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(204)

      const stages = await dealStages()

      expect(stages.map((stage) => stage.slug)).toEqual([
        'qualifying',
        'negotiation',
        'won',
        'lost',
      ])
      expect(stages.map((stage) => stage.sort_order)).toEqual([0, 1, 2, 3])
    })

    it('answers 409 when records sit in the stage and no move_to is given', async () => {
      const id = await stageIdBySlug('proposal')

      await createDealIn(id)

      const response = await client.send('DELETE', `/v1/pipeline_stages/${id}`, {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(409)
    })

    it('moves the stage\'s deals to move_to, with a stage_changed trail', async () => {
      const from = await stageIdBySlug('proposal')
      const to = await stageIdBySlug('negotiation')
      const dealId = await createDealIn(from)

      const response = await client.send(
        'DELETE',
        `/v1/pipeline_stages/${from}?move_to=${to}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(204)

      const deal = await client.send('GET', `/v1/deals/${dealId}`, { cookie: acme.cookie })

      expect(readRecord(await deal.json()).stage_id).toBe(to)

      const activities = await client.send(
        'GET',
        `/v1/activities?target_type=deal&target_id=${dealId}`,
        { cookie: acme.cookie },
      )
      const moved = readList(await activities.json()).find(
        (activity) => activity.kind === 'stage_changed',
      )

      expect(moved).toBeDefined()
      expect(moved?.action).toBe('moved to Negotiation')
      expect(moved?.detail).toBe('Proposal → Negotiation')
    })

    it('refuses a move_to from another pipeline with 422', async () => {
      const from = await stageIdBySlug('proposal')
      const opportunityStages = await client.send('GET', '/v1/pipeline_stages?kind=opportunity', {
        cookie: acme.cookie,
      })
      const elsewhere = readString(readList(await opportunityStages.json())[0] ?? {}, 'id')

      const response = await client.send(
        'DELETE',
        `/v1/pipeline_stages/${from}?move_to=${elsewhere}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(422)
    })

    it('refuses to remove the last stage of a pipeline', async () => {
      const stages = await dealStages()

      for (const stage of stages.slice(0, -1)) {
        const removed = await client.send('DELETE', `/v1/pipeline_stages/${readString(stage, 'id')}`, {
          cookie: acme.cookie,
        })

        expect(removed.status).toBe(204)
      }

      const last = stages.at(-1)
      const response = await client.send(
        'DELETE',
        `/v1/pipeline_stages/${readString(last ?? {}, 'id')}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(409)
    })
  })
})

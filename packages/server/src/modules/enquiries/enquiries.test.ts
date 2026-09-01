import { dealSchema, enquirySchema } from '@kelpie/schemas'
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

/** `/v1/enquiries` against real Postgres. CRUD, stage moves, and convert-to-deal. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('enquiries', () => {
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

  async function createPerson(name: string, email: string): Promise<string> {
    const response = await client.send('POST', '/v1/people', {
      body: { name, email },
      cookie: acme.cookie,
    })

    return readString(await response.json(), 'id')
  }

  async function enquiryStage(slug: string): Promise<string> {
    const response = await client.send('GET', '/v1/pipeline_stages?kind=enquiry', {
      cookie: acme.cookie,
    })
    const found = readList(await response.json()).find((stage) => stage.slug === slug)

    if (found === undefined) {
      throw new Error(`No enquiry stage with slug ${slug}`)
    }

    return readString(found, 'id')
  }

  async function createEnquiry(
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', '/v1/enquiries', {
      body: { name: 'Website demo request', ...body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function activitiesFor(
    targetType: string,
    targetId: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/activities?target_type=${targetType}&target_id=${targetId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  async function createNote(targetType: string, targetId: string, body: string): Promise<void> {
    const response = await client.send('POST', '/v1/notes', {
      body: { target_type: targetType, target_id: targetId, body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)
  }

  async function notesFor(targetType: string, targetId: string): Promise<Record<string, unknown>[]> {
    const response = await client.send(
      'GET',
      `/v1/notes?target_type=${targetType}&target_id=${targetId}`,
      { cookie: acme.cookie },
    )

    return readList(await response.json())
  }

  describe('creating', () => {
    it('creates an enquiry from a name alone, with honest defaults', async () => {
      const enquiry = await createEnquiry()

      expect(enquiry.id).toMatch(/^enq_/u)
      expect(enquiry.source).toBe('')
      expect(enquiry.stage_id).toBe(await enquiryStage('new'))
      expect(enquiry.company_id).toBeNull()
      expect(enquiry.owner_id).toMatch(/^mem_/u)
      expect(enquiry.converted_deal_id).toBeNull()
      expect(enquiry.summary).toBe('')
      expect(enquiry.tags).toEqual([])
      expect(enquiry.person_ids).toEqual([])
    })

    it('files the creation on the enquiry\'s timeline', async () => {
      const enquiry = await createEnquiry()
      const activities = await activitiesFor('enquiry', readString(enquiry, 'id'))

      expect(activities.some((activity) => activity.action === 'created Enquiry')).toBe(true)
    })

    it('parses back through the shared enquirySchema', async () => {
      const wire = await createEnquiry()

      expect(() => enquirySchema.parse(wire)).not.toThrow()
    })

    it('refuses a stage from another pipeline with 422', async () => {
      const stages = await client.send('GET', '/v1/pipeline_stages?kind=deal', {
        cookie: acme.cookie,
      })
      const dealStage = readString(readList(await stages.json())[0] ?? {}, 'id')
      const response = await client.send('POST', '/v1/enquiries', {
        body: { name: 'Wrong board', stage_id: dealStage },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('updating', () => {
    it('files stage_changed on a stage move', async () => {
      const enquiry = await createEnquiry()
      const inProgress = await enquiryStage('in_progress')

      await client.send('PATCH', `/v1/enquiries/${readString(enquiry, 'id')}`, {
        body: { stage_id: inProgress },
        cookie: acme.cookie,
      })

      const activities = await activitiesFor('enquiry', readString(enquiry, 'id'))
      expect(
        activities.some(
          (activity) => typeof activity.action === 'string' && activity.action.startsWith('moved to'),
        ),
      ).toBe(true)
    })

    it('refuses converted_deal_id in an update body with 422', async () => {
      const enquiry = await createEnquiry()
      const response = await client.send('PATCH', `/v1/enquiries/${readString(enquiry, 'id')}`, {
        body: { converted_deal_id: 'deal_pretend' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })
  })

  describe('convert to deal', () => {
    it('creates a deal from the enquiry, moves the enquiry to closed, and records the pointer', async () => {
      const companyId = await createCompany('Northwind Traders')
      const personId = await createPerson('Ada Lovelace', 'ada@northwind.dev')
      const enquiry = await createEnquiry({
        company_id: companyId,
        person_ids: [personId],
        source: 'Website',
        summary: 'Wants a demo next week.',
      })
      const enquiryId = readString(enquiry, 'id')

      const response = await client.send(
        'POST',
        `/v1/enquiries/${enquiryId}/convert`,
        { body: {}, cookie: acme.cookie },
      )

      expect(response.status).toBe(201)
      const deal = readRecord(await response.json())
      expect(deal.id).toMatch(/^deal_/u)
      expect(() => dealSchema.parse(deal)).not.toThrow()
      expect(deal.company_id).toBe(companyId)
      expect(deal.person_ids).toEqual([personId])
      expect(deal.name).toBe('Website demo request')

      const readBack = await client.send('GET', `/v1/enquiries/${enquiryId}`, {
        cookie: acme.cookie,
      })
      const updated = readRecord(await readBack.json())
      expect(updated.converted_deal_id).toBe(deal.id)
      expect(updated.stage_id).toBe(await enquiryStage('closed'))

      const dealActivities = await activitiesFor('deal', readString(deal, 'id'))
      expect(
        dealActivities.some(
          (activity) =>
            typeof activity.action === 'string' && activity.action.includes('from Enquiry'),
        ),
      ).toBe(true)

      const enquiryActivities = await activitiesFor('enquiry', enquiryId)
      expect(
        enquiryActivities.some(
          (activity) =>
            typeof activity.action === 'string' && activity.action.startsWith('converted to'),
        ),
      ).toBe(true)
    })

    it('repoints notes and plan items to the new deal', async () => {
      const companyId = await createCompany('Contoso')
      const enquiry = await createEnquiry({ company_id: companyId })
      const enquiryId = readString(enquiry, 'id')

      await createNote('enquiry', enquiryId, 'Asked about enterprise pricing.')

      const planResponse = await client.send('POST', '/v1/plan_items', {
        body: {
          target_type: 'enquiry',
          target_id: enquiryId,
          title: 'Send proposal',
          date: '2026-09-15',
        },
        cookie: acme.cookie,
      })
      expect(planResponse.status).toBe(201)

      const convert = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
        body: {},
        cookie: acme.cookie,
      })
      expect(convert.status).toBe(201)
      const deal = readRecord(await convert.json())
      const dealId = readString(deal, 'id')

      const notesOnDeal = await notesFor('deal', dealId)
      expect(notesOnDeal).toHaveLength(1)
      expect(notesOnDeal[0]?.body).toBe('Asked about enterprise pricing.')
      expect(await notesFor('enquiry', enquiryId)).toHaveLength(0)

      const planResponseAfter = await client.send(
        'GET',
        `/v1/plan_items?target_type=deal&target_id=${dealId}`,
        { cookie: acme.cookie },
      )
      expect(readList(await planResponseAfter.json())).toHaveLength(1)
    })

    it('refuses a convert without a linked company with 422', async () => {
      const enquiry = await createEnquiry()
      const response = await client.send(
        'POST',
        `/v1/enquiries/${readString(enquiry, 'id')}/convert`,
        { body: {}, cookie: acme.cookie },
      )

      expect(response.status).toBe(422)
    })

    it('409s a second convert', async () => {
      const companyId = await createCompany('Northwind')
      const enquiry = await createEnquiry({ company_id: companyId })

      const first = await client.send(
        'POST',
        `/v1/enquiries/${readString(enquiry, 'id')}/convert`,
        { body: {}, cookie: acme.cookie },
      )
      expect(first.status).toBe(201)

      const second = await client.send(
        'POST',
        `/v1/enquiries/${readString(enquiry, 'id')}/convert`,
        { body: {}, cookie: acme.cookie },
      )
      expect(second.status).toBe(409)
    })

    it('unblocks convert again once the deal is deleted', async () => {
      const companyId = await createCompany('Northwind')
      const enquiry = await createEnquiry({ company_id: companyId })
      const enquiryId = readString(enquiry, 'id')

      const first = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
        body: {},
        cookie: acme.cookie,
      })
      const firstDeal = readRecord(await first.json())

      const deleted = await client.send('DELETE', `/v1/deals/${readString(firstDeal, 'id')}`, {
        cookie: acme.cookie,
      })
      expect(deleted.status).toBe(204)

      const readBack = await client.send('GET', `/v1/enquiries/${enquiryId}`, {
        cookie: acme.cookie,
      })
      const updated = readRecord(await readBack.json())
      expect(updated.converted_deal_id).toBeNull()
      expect(updated.converted_to).toBeNull()

      const again = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
        body: {},
        cookie: acme.cookie,
      })
      expect(again.status).toBe(201)
    })
  })

  describe('deleting', () => {
    it('deletes the enquiry and returns 204', async () => {
      const enquiry = await createEnquiry()
      const response = await client.send(
        'DELETE',
        `/v1/enquiries/${readString(enquiry, 'id')}`,
        { cookie: acme.cookie },
      )

      expect(response.status).toBe(204)
    })
  })
})

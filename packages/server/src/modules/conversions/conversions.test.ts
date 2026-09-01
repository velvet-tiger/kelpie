import {
  convertPipelineRecordRequest,
  dealSchema,
  enquirySchema,
  opportunitySchema,
} from '@kelpie/schemas'
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

/** Pipeline conversion across the five record types. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('pipeline conversions', () => {
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

  async function createCompany(name: string): Promise<string> {
    const response = await client.send('POST', '/v1/companies', {
      body: { name },
      cookie: acme.cookie,
    })

    return readString(await response.json(), 'id')
  }

  async function createPerson(name: string, email: string): Promise<string> {
    const response = await client.send('POST', '/v1/people', {
      body: { name, email },
      cookie: acme.cookie,
    })

    return readString(await response.json(), 'id')
  }

  async function createDeal(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const companyId =
      typeof body.company_id === 'string' ? body.company_id : await createCompany('Northwind')
    const response = await client.send('POST', '/v1/deals', {
      body: { name: 'Enterprise licence', company_id: companyId, ...body },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
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

  it('repoints notes and records converted_to when a deal becomes an opportunity', async () => {
    const companyId = await createCompany('Contoso')
    const personId = await createPerson('Ada Lovelace', 'ada@contoso.dev')
    const deal = await createDeal({ company_id: companyId, person_ids: [personId], summary: 'Hot lead' })
    const dealId = readString(deal, 'id')

    await createNote('deal', dealId, 'Met at the conference.')

    const response = await client.send('POST', `/v1/deals/${dealId}/convert`, {
      body: convertPipelineRecordRequest({ targetType: 'opportunity', kind: 'Grant' }),
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)
    const opportunity = readRecord(await response.json())
    expect(() => opportunitySchema.parse(opportunity)).not.toThrow()
    expect(opportunity.kind).toBe('Grant')
    expect(opportunity.person_ids).toEqual([personId])

    const dealReadBack = readRecord(
      await (
        await client.send('GET', `/v1/deals/${dealId}`, { cookie: acme.cookie })
      ).json(),
    )
    expect(dealReadBack.converted_to).toEqual({
      target_type: 'opportunity',
      target_id: readString(opportunity, 'id'),
    })

    const notesOnOpportunity = await notesFor('opportunity', readString(opportunity, 'id'))
    expect(notesOnOpportunity).toHaveLength(1)
    expect(notesOnOpportunity[0]?.body).toBe('Met at the conference.')

    expect(await notesFor('deal', dealId)).toHaveLength(0)
  })

  it('409s a second conversion on the same record', async () => {
    const deal = await createDeal()
    const dealId = readString(deal, 'id')

    const first = await client.send('POST', `/v1/deals/${dealId}/convert`, {
      body: convertPipelineRecordRequest({ targetType: 'opportunity' }),
      cookie: acme.cookie,
    })
    expect(first.status).toBe(201)

    const second = await client.send('POST', `/v1/deals/${dealId}/convert`, {
      body: convertPipelineRecordRequest({ targetType: 'partnership', kind: 'Integration' }),
      cookie: acme.cookie,
    })
    expect(second.status).toBe(409)
  })

  it('422s deal to partnership without a company', async () => {
    const response = await client.send('POST', '/v1/opportunities', {
      body: { name: 'Speaking slot' },
      cookie: acme.cookie,
    })
    expect(response.status).toBe(201)
    const opportunity = readRecord(await response.json())

    const convert = await client.send(
      'POST',
      `/v1/opportunities/${readString(opportunity, 'id')}/convert`,
      {
        body: convertPipelineRecordRequest({ targetType: 'partnership', kind: 'Co-marketing' }),
        cookie: acme.cookie,
      },
    )

    expect(convert.status).toBe(422)
  })

  it('still converts enquiries to deals with an empty body', async () => {
    const companyId = await createCompany('Fabrikam')
    const response = await client.send('POST', '/v1/enquiries', {
      body: { name: 'Pricing question', company_id: companyId },
      cookie: acme.cookie,
    })
    expect(response.status).toBe(201)
    const enquiry = readRecord(await response.json())
    const enquiryId = readString(enquiry, 'id')

    const convert = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
      body: {},
      cookie: acme.cookie,
    })

    expect(convert.status).toBe(201)
    const deal = readRecord(await convert.json())
    expect(() => dealSchema.parse(deal)).not.toThrow()

    const readBack = readRecord(
      await (
        await client.send('GET', `/v1/enquiries/${enquiryId}`, { cookie: acme.cookie })
      ).json(),
    )
    expect(() => enquirySchema.parse(readBack)).not.toThrow()
    expect(readBack.converted_deal_id).toBe(readString(deal, 'id'))
    expect(readBack.converted_to).toEqual({
      target_type: 'deal',
      target_id: readString(deal, 'id'),
    })
  })
})

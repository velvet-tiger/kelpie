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

  it('404s a company_id from another workspace and converts nothing', async () => {
    const other = await client.owner('grace@example.com')
    const foreign = await client.send('POST', '/v1/companies', {
      body: { name: 'Contoso', domain: 'contoso.example' },
      cookie: other.cookie,
    })
    expect(foreign.status).toBe(201)
    const foreignCompanyId = readString(await foreign.json(), 'id')

    const deal = await createDeal()
    const dealId = readString(deal, 'id')

    const convert = await client.send('POST', `/v1/deals/${dealId}/convert`, {
      body: convertPipelineRecordRequest({ targetType: 'opportunity', companyId: foreignCompanyId }),
      cookie: acme.cookie,
    })
    expect(convert.status).toBe(404)

    const readBack = readRecord(
      await (await client.send('GET', `/v1/deals/${dealId}`, { cookie: acme.cookie })).json(),
    )
    expect(readBack.converted_to).toBeNull()

    const opportunities = readList(
      await (await client.send('GET', '/v1/opportunities', { cookie: acme.cookie })).json(),
    )
    expect(opportunities).toHaveLength(0)
  })

  it('accepts a company_id from this workspace', async () => {
    const companyId = await createCompany('Fabrikam')
    const deal = await createDeal()

    const convert = await client.send('POST', `/v1/deals/${readString(deal, 'id')}/convert`, {
      body: convertPipelineRecordRequest({ targetType: 'opportunity', companyId }),
      cookie: acme.cookie,
    })

    expect(convert.status).toBe(201)
    expect(readRecord(await convert.json()).company_id).toBe(companyId)
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

  describe('scopes of a conversion', () => {
    async function key(scopes: readonly string[]): Promise<string> {
      const response = await client.send('POST', '/v1/api-keys', {
        body:
          scopes.length === 0
            ? { name: 'agent', kind: 'workspace', full_access: true }
            : { name: 'agent', kind: 'workspace', scopes },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(201)

      return readString(await response.json(), 'secret')
    }

    async function createEnquiry(): Promise<string> {
      const response = await client.send('POST', '/v1/enquiries', {
        body: { name: 'Inbound from site', company_id: await createCompany('Fabrikam') },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(201)

      return readString(await response.json(), 'id')
    }

    /** One tool call over `/mcp`: whether the tool refused, and the JSON it answered. */
    async function callTool(
      bearer: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ readonly isError: boolean; readonly payload: Record<string, unknown> }> {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      const result = readRecord(readRecord(await response.json()).result)
      const [content] = result.content as { text: string }[]

      return { isError: result.isError === true, payload: readRecord(JSON.parse(content?.text ?? 'null')) }
    }

    function errorMessage(payload: unknown): string {
      return readString(readRecord(payload).error, 'message')
    }

    async function listOf(path: string): Promise<Record<string, unknown>[]> {
      return readList(await (await client.send('GET', path, { cookie: acme.cookie })).json())
    }

    async function isConverted(path: string): Promise<boolean> {
      const record = readRecord(await (await client.send('GET', path, { cookie: acme.cookie })).json())

      return record.converted_to !== null && record.converted_to !== undefined
    }

    it('refuses a REST convert to a key with the source write scope and no target write scope', async () => {
      const enquiryId = await createEnquiry()
      const dealId = readString(await createDeal(), 'id')
      const enquiriesOnly = await key(['enquiries:write'])
      const dealsOnly = await key(['deals:write'])

      // The target type fixed by the default: an enquiry becomes a Deal.
      const toDeal = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
        body: {},
        bearer: enquiriesOnly,
      })

      expect(toDeal.status).toBe(403)
      expect(errorMessage(await toDeal.json())).toBe('This API key does not have the deals:write scope')

      // The target type chosen in the body.
      const toOpportunity = await client.send('POST', `/v1/deals/${dealId}/convert`, {
        body: { target_type: 'opportunity', kind: 'grant' },
        bearer: dealsOnly,
      })

      expect(toOpportunity.status).toBe(403)
      expect(errorMessage(await toOpportunity.json())).toBe(
        'This API key does not have the opportunities:write scope',
      )

      // The target write scope alone is not enough either: the source changes.
      const fromEnquiry = await client.send('POST', `/v1/enquiries/${enquiryId}/convert`, {
        body: {},
        bearer: dealsOnly,
      })

      expect(fromEnquiry.status).toBe(403)

      expect(await listOf('/v1/deals')).toHaveLength(1)
      expect(await listOf('/v1/opportunities')).toHaveLength(0)
      expect(await isConverted(`/v1/enquiries/${enquiryId}`)).toBe(false)
      expect(await isConverted(`/v1/deals/${dealId}`)).toBe(false)
    })

    it('refuses the convert tools over MCP in the same way', async () => {
      const enquiryId = await createEnquiry()
      const enquiriesOnly = await key(['enquiries:write'])

      for (const [tool, args] of [
        ['enquiries_convert_to_deal', { id: enquiryId }],
        ['enquiries_convert', { id: enquiryId, target_type: 'deal' }],
        ['enquiries_convert', { id: enquiryId, target_type: 'opportunity', kind: 'grant' }],
      ] as const) {
        const refused = await callTool(enquiriesOnly, tool, args)

        expect(refused.isError, tool).toBe(true)
        expect(errorMessage(refused.payload), tool).toMatch(
          /^This API key does not have the (?:deals|opportunities):write scope$/u,
        )
      }

      expect(await listOf('/v1/deals')).toHaveLength(0)
      expect(await listOf('/v1/opportunities')).toHaveLength(0)
      expect(await isConverted(`/v1/enquiries/${enquiryId}`)).toBe(false)
    })

    it('converts for a key with both write scopes, on REST and on MCP', async () => {
      const both = await key(['enquiries:write', 'deals:write'])
      const overRest = await client.send('POST', `/v1/enquiries/${await createEnquiry()}/convert`, {
        body: {},
        bearer: both,
      })

      expect(overRest.status).toBe(201)

      const overMcp = await callTool(both, 'enquiries_convert', {
        id: await createEnquiry(),
        target_type: 'deal',
      })

      expect(overMcp.isError).toBe(false)
      expect(await listOf('/v1/deals')).toHaveLength(2)
    })

    it('converts for a preset that holds both, a full-access key and a session, as before', async () => {
      for (const scopes of [['write:objects'], []]) {
        const response = await client.send('POST', `/v1/enquiries/${await createEnquiry()}/convert`, {
          body: {},
          bearer: await key(scopes),
        })

        expect(response.status, scopes.join(',')).toBe(201)
      }

      const bySession = await client.send('POST', `/v1/enquiries/${await createEnquiry()}/convert`, {
        body: {},
        cookie: acme.cookie,
      })

      expect(bySession.status).toBe(201)
    })
  })
})

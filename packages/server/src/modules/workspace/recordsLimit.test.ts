import { count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { people } from '../people/schema.ts'
import { RECORDS_LIMIT } from './capabilities.ts'
import { countRecordsInUse } from './repository.ts'

/**
 * `records.limit` against real Postgres: person create, company create and
 * import commit are gated; a form submission and the sample-data install are
 * not.
 */

const connectionString = testDatabaseUrl(process.env)

const TWO_COMPANIES_CSV = [
  'name,domain',
  'Acme,acme.com',
  'Harbour Lane,harbour.io',
].join('\n')

const TWO_PEOPLE_CSV = [
  'name,email',
  'Ada Lovelace,ada@analytical.example',
  'Grace Hopper,grace@univac.example',
].join('\n')

const CONTACT_FIELDS = [
  { label: 'Name', type: 'text', map_to: 'person.name', required: true },
  { label: 'Email', type: 'email', map_to: 'person.email', required: true },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe.skipIf(connectionString === undefined)('the record limit', () => {
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
    // Wait for any async subscribers still running against the last test's
    // harness — they hold row-share locks that would deadlock the truncate.
    if (harness !== undefined) {
      await harness.services.events.drain()
    }
    await database.truncateAll()
  })

  function createPerson(name: string): Promise<Response> {
    return client.send('POST', '/v1/people', { body: { name }, cookie: acme.cookie })
  }

  function createCompany(name: string): Promise<Response> {
    return client.send('POST', '/v1/companies', { body: { name }, cookie: acme.cookie })
  }

  /** A multipart upload: the dry run that leaves a job `ready`. */
  async function createJob(csv: string, object: string, conflictMode = 'skip'): Promise<string> {
    const form = new FormData()

    form.set('file', new File([csv], 'upload.csv', { type: 'text/csv' }))
    form.set('source', 'custom')
    form.set('object', object)
    form.set('conflict_mode', conflictMode)

    const response = await harness.app.request('/v1/import/jobs', {
      method: 'POST',
      headers: { Cookie: acme.cookie },
      body: form,
    })

    if (response.status !== 201) {
      throw new Error(`Creating a job answered ${String(response.status)}: ${await response.text()}`)
    }

    return readString(await response.json(), 'id')
  }

  function commit(jobId: string, csv: string): Promise<Response> {
    const form = new FormData()

    form.set('file', new File([csv], 'upload.csv', { type: 'text/csv' }))

    return Promise.resolve(
      harness.app.request(`/v1/import/jobs/${jobId}/commit`, {
        method: 'POST',
        headers: { Cookie: acme.cookie },
        body: form,
      }),
    )
  }

  async function peopleCount(): Promise<number> {
    const [row] = await database.db
      .select({ total: count() })
      .from(people)
      .where(eq(people.workspaceId, acme.workspaceId))

    return row?.total ?? 0
  }

  async function companyCount(): Promise<number> {
    const [row] = await database.db
      .select({ total: count() })
      .from(companies)
      .where(eq(companies.workspaceId, acme.workspaceId))

    return row?.total ?? 0
  }

  describe('with no grant provider, as a self-hosted install runs', () => {
    beforeEach(async () => {
      harness = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
      })
      client = createTestClient(harness.app, harness.services.db)
      acme = await client.owner()
    })

    it('declares the capability and answers unlimited', async () => {
      expect(harness.contributions.entitlements.capabilities()).toContainEqual(RECORDS_LIMIT)
      expect(
        await harness.contributions.entitlements.check(acme.workspaceId, RECORDS_LIMIT.name),
      ).toEqual({ kind: 'limit', limit: null })
    })

    it('never refuses a person, a company or an import', async () => {
      for (const name of ['Ada', 'Grace', 'Katherine']) {
        expect((await createPerson(name)).status).toBe(201)
      }

      for (const name of ['Initech', 'Hooli']) {
        expect((await createCompany(name)).status).toBe(201)
      }

      const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')
      const committed = await commit(jobId, TWO_COMPANIES_CSV)

      expect(committed.status).toBe(200)
      expect(await committed.json()).toMatchObject({ status: 'completed', counts: { create: 2 } })
      expect(await countRecordsInUse(database.db, acme.workspaceId)).toBe(7)
    })
  })

  describe('with a provider that answers a limit', () => {
    /** What the provider answers. A test moves it, as a plan change would. */
    let limit: number

    beforeEach(async () => {
      limit = 3

      // Answers `records.limit` only. Every other capability keeps the default,
      // which is the shape a plan catalog registers.
      const entitlements = createEntitlementRegistry()
      entitlements.provide((_workspaceId, capability) =>
        Promise.resolve(
          capability.name === RECORDS_LIMIT.name ? { kind: 'limit', limit } : undefined,
        ),
      )

      harness = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
        entitlements,
      })
      client = createTestClient(harness.app, harness.services.db)
      acme = await client.owner()
    })

    it('starts a new workspace with no records in use', async () => {
      expect(await countRecordsInUse(database.db, acme.workspaceId)).toBe(0)
    })

    it('counts people plus companies, in the one workspace only', async () => {
      expect((await createPerson('Ada')).status).toBe(201)
      expect((await createCompany('Initech')).status).toBe(201)

      const other = await client.owner('grace@example.com')
      await client.send('POST', '/v1/people', { body: { name: 'Elsewhere' }, cookie: other.cookie })

      expect(await countRecordsInUse(database.db, acme.workspaceId)).toBe(2)
      expect(await countRecordsInUse(database.db, other.workspaceId)).toBe(1)
    })

    describe('creating a person', () => {
      it('is allowed under the limit, up to the last record', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          expect((await createPerson(name)).status).toBe(201)
        }

        expect(await peopleCount()).toBe(3)
      })

      it('is refused at the limit with 403 entitlement_required', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          await createPerson(name)
        }

        const refused = await createPerson('Margaret')

        expect(refused.status).toBe(403)
        // The same body shape the seat limit answers: a code and a message, no details.
        expect(await refused.json()).toEqual({
          error: {
            code: 'entitlement_required',
            message: 'Your plan allows 3 records (people plus companies)',
          },
        })
        expect(await peopleCount()).toBe(3)
      })

      it('is refused over the limit, after the limit moved under the count', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          await createPerson(name)
        }

        limit = 1

        const refused = await createPerson('Margaret')

        expect(refused.status).toBe(403)
        expect(await refused.json()).toEqual({
          error: {
            code: 'entitlement_required',
            message: 'Your plan allows 1 record (people plus companies)',
          },
        })
      })

      it('is refused when companies took the room', async () => {
        for (const name of ['Initech', 'Hooli', 'Univac']) {
          expect((await createCompany(name)).status).toBe(201)
        }

        expect((await createPerson('Ada')).status).toBe(403)
      })

      it('is refused through the MCP tool too', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          await createPerson(name)
        }

        const minted = await client.send('POST', '/v1/api-keys', {
          body: { name: 'agent', kind: 'workspace' },
          cookie: acme.cookie,
        })
        const key = readString(await minted.json(), 'secret')
        const response = await harness.app.request('/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'people_create', arguments: { name: 'Margaret' } },
          }),
        })
        const result = readRecord(readRecord(await response.json()).result)
        const content: unknown = Array.isArray(result.content) ? result.content[0] : undefined
        const text = isRecord(content) && typeof content.text === 'string' ? content.text : 'null'

        expect(result.isError).toBe(true)
        expect(JSON.parse(text)).toMatchObject({ error: { code: 'entitlement_required' } })
        expect(await peopleCount()).toBe(3)
      })
    })

    describe('creating a company', () => {
      it('is allowed under the limit, up to the last record', async () => {
        for (const name of ['Initech', 'Hooli', 'Univac']) {
          expect((await createCompany(name)).status).toBe(201)
        }

        expect(await companyCount()).toBe(3)
      })

      it('is refused at the limit with 403 entitlement_required', async () => {
        for (const name of ['Initech', 'Hooli', 'Univac']) {
          await createCompany(name)
        }

        const refused = await createCompany('Bletchley')

        expect(refused.status).toBe(403)
        expect(await refused.json()).toEqual({
          error: {
            code: 'entitlement_required',
            message: 'Your plan allows 3 records (people plus companies)',
          },
        })
        expect(await companyCount()).toBe(3)
      })

      it('is refused over the limit, after the limit moved under the count', async () => {
        for (const name of ['Initech', 'Hooli', 'Univac']) {
          await createCompany(name)
        }

        limit = 0

        const refused = await createCompany('Bletchley')

        expect(refused.status).toBe(403)
        expect(readRecord(readRecord(await refused.json()).error).code).toBe('entitlement_required')
      })

      it('is refused when people took the room', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          expect((await createPerson(name)).status).toBe(201)
        }

        expect((await createCompany('Initech')).status).toBe(403)
      })
    })

    describe('over the limit', () => {
      it('still reads, edits and deletes, and a delete makes room again', async () => {
        const ids: string[] = []

        for (const name of ['Ada', 'Grace', 'Katherine']) {
          ids.push(readString(await (await createPerson(name)).json(), 'id'))
        }

        limit = 2

        const [first, second] = ids

        expect((await client.send('GET', '/v1/people', { cookie: acme.cookie })).status).toBe(200)
        expect(
          (
            await client.send('PATCH', `/v1/people/${first ?? ''}`, {
              body: { summary: 'Wrote the first program' },
              cookie: acme.cookie,
            })
          ).status,
        ).toBe(200)
        expect((await createPerson('Margaret')).status).toBe(403)

        // One delete leaves two of two: still no room.
        expect(
          (await client.send('DELETE', `/v1/people/${first ?? ''}`, { cookie: acme.cookie })).status,
        ).toBe(204)
        expect((await createPerson('Margaret')).status).toBe(403)

        // A second leaves one of two.
        expect(
          (await client.send('DELETE', `/v1/people/${second ?? ''}`, { cookie: acme.cookie })).status,
        ).toBe(204)
        expect((await createPerson('Margaret')).status).toBe(201)
      })
    })

    describe('committing an import', () => {
      it('is allowed when the forecast fits under the limit', async () => {
        const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')
        const committed = await commit(jobId, TWO_COMPANIES_CSV)

        expect(committed.status).toBe(200)
        expect(await committed.json()).toMatchObject({ status: 'completed', counts: { create: 2 } })
        expect(await companyCount()).toBe(2)
      })

      it('is allowed when the forecast takes exactly the room left', async () => {
        await createPerson('Ada')

        const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')
        const committed = await commit(jobId, TWO_COMPANIES_CSV)

        expect(committed.status).toBe(200)
        expect(await countRecordsInUse(database.db, acme.workspaceId)).toBe(3)
      })

      it('refuses a companies import that would create more than the room left', async () => {
        await createPerson('Ada')
        await createPerson('Grace')

        const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')
        const refused = await commit(jobId, TWO_COMPANIES_CSV)

        expect(refused.status).toBe(403)
        // Both numbers: what the import would create, and the room left.
        expect(await refused.json()).toEqual({
          error: {
            code: 'entitlement_required',
            message:
              'This import would create 2 records and your plan has room for 1 more (2 of 3 in use)',
          },
        })
        // All or nothing: not one row of the file was written.
        expect(await companyCount()).toBe(0)
      })

      it('refuses a people import that would create more than the room left', async () => {
        await createCompany('Initech')
        await createCompany('Hooli')

        const jobId = await createJob(TWO_PEOPLE_CSV, 'people')
        const refused = await commit(jobId, TWO_PEOPLE_CSV)

        expect(refused.status).toBe(403)
        expect(readRecord(readRecord(await refused.json()).error).code).toBe('entitlement_required')
        expect(await peopleCount()).toBe(0)
      })

      it('refuses when the workspace is already over the limit, with no room to report', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          await createPerson(name)
        }

        limit = 1

        const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')
        const refused = await commit(jobId, TWO_COMPANIES_CSV)

        expect(refused.status).toBe(403)
        expect(readString(readRecord(await refused.json()).error, 'message')).toBe(
          'This import would create 2 records and your plan has room for 0 more (3 of 1 in use)',
        )
      })

      it('leaves a refused job ready, so the same file commits once there is room', async () => {
        await createPerson('Ada')
        await createPerson('Grace')

        const jobId = await createJob(TWO_COMPANIES_CSV, 'companies')

        expect((await commit(jobId, TWO_COMPANIES_CSV)).status).toBe(403)

        const job = await client.send('GET', `/v1/import/jobs/${jobId}`, { cookie: acme.cookie })

        expect(readString(await job.json(), 'status')).toBe('ready')

        limit = 4

        const committed = await commit(jobId, TWO_COMPANIES_CSV)

        expect(committed.status).toBe(200)
        expect(await committed.json()).toMatchObject({ status: 'completed', counts: { create: 2 } })
      })

      it('still commits an import that only updates, at the limit', async () => {
        await createCompany('Initech')

        const seeded = await createJob(TWO_COMPANIES_CSV, 'companies')

        expect((await commit(seeded, TWO_COMPANIES_CSV)).status).toBe(200)
        expect(await countRecordsInUse(database.db, acme.workspaceId)).toBe(3)

        const changed = [
          'name,domain,industry',
          'Acme,acme.com,Software',
          'Harbour Lane,harbour.io,Logistics',
        ].join('\n')
        const jobId = await createJob(changed, 'companies', 'update')
        const committed = await commit(jobId, changed)

        expect(committed.status).toBe(200)
        expect(await committed.json()).toMatchObject({
          status: 'completed',
          counts: { create: 0, update: 2 },
        })
      })
    })

    describe('the paths that are not gated', () => {
      it('accepts a form submission over the limit, and creates the person', async () => {
        for (const name of ['Ada', 'Grace', 'Katherine']) {
          await createPerson(name)
        }

        const created = await client.send('POST', '/v1/forms', {
          body: { name: 'Website contact', fields: CONTACT_FIELDS },
          cookie: acme.cookie,
        })

        expect(created.status).toBe(201)

        const form = readRecord(await created.json())
        const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : []
        const answers = Object.fromEntries(
          fields.map((field) => [
            String(field.id),
            field.label === 'Email' ? 'alex@example.com' : 'Alex Rivera',
          ]),
        )
        const submitted = await client.send(
          'POST',
          `/v1/public/workspaces/${acme.workspaceId}/forms/${readString(form, 'slug')}/submit`,
          { body: { answers } },
        )

        expect(submitted.status).toBe(201)
        expect(await peopleCount()).toBe(4)
        // The meter is over, so a create by hand is still refused.
        expect((await createPerson('Margaret')).status).toBe(403)
      })

      it('installs the sample data on a plan with no room at all', async () => {
        limit = 0

        const installed = await client.send(
          'POST',
          `/v1/workspaces/${acme.workspaceId}/sample-data`,
          { cookie: acme.cookie },
        )

        expect(installed.status).toBe(201)
        expect(await peopleCount()).toBeGreaterThan(0)
        expect(await companyCount()).toBeGreaterThan(0)
        expect((await createPerson('Margaret')).status).toBe(403)
      })
    })
  })
})

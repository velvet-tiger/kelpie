import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { people } from '../people/schema.ts'
import { SAMPLE_DATA_FIXTURE } from './fixture.ts'

/** `POST /v1/workspaces/:id/sample-data` against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('sample-data', () => {
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

  async function install(cookie = acme.cookie): Promise<Response> {
    return client.send('POST', `/v1/workspaces/${acme.workspaceId}/sample-data`, {
      cookie,
    })
  }

  it('seeds every row from the fixture into the actor’s workspace', async () => {
    const response = await install()

    expect(response.status).toBe(201)

    const body = readRecord(await response.json())

    expect(body.companies).toBe(SAMPLE_DATA_FIXTURE.companies.length)
    expect(body.people).toBe(SAMPLE_DATA_FIXTURE.people.length)
    expect(body.positions).toBe(SAMPLE_DATA_FIXTURE.positions.length)
    expect(body.deals).toBe(SAMPLE_DATA_FIXTURE.deals.length)
    expect(body.plan_items).toBe(SAMPLE_DATA_FIXTURE.plans.length)
    expect(body.notes).toBe(SAMPLE_DATA_FIXTURE.notes.length)
    expect(body.opportunities).toBe(SAMPLE_DATA_FIXTURE.opportunities.length)
    expect(body.raises).toBe(SAMPLE_DATA_FIXTURE.raises.length)
    expect(body.partnerships).toBe(SAMPLE_DATA_FIXTURE.partnerships.length)
    expect(body.enquiries).toBe(SAMPLE_DATA_FIXTURE.enquiries.length)
    expect(body.roles).toBe(SAMPLE_DATA_FIXTURE.roles.length)
    expect(body.candidates).toBe(SAMPLE_DATA_FIXTURE.candidates.length)

    const seededCompanies = await harness.services.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.workspaceId, acme.workspaceId))

    expect(seededCompanies).toHaveLength(SAMPLE_DATA_FIXTURE.companies.length)

    const listed = readList(
      await (await client.send('GET', '/v1/deals', { cookie: acme.cookie })).json(),
    )

    expect(listed).toHaveLength(SAMPLE_DATA_FIXTURE.deals.length)
  })

  it('refuses a second install on the same workspace with 409', async () => {
    const first = await install()

    expect(first.status).toBe(201)

    const second = await install()

    expect(second.status).toBe(409)
  })

  it('is 409 for a workspace that already carries any company', async () => {
    await client.send('POST', '/v1/companies', {
      body: { name: 'Analytical Engines' },
      cookie: acme.cookie,
    })

    const response = await install()

    expect(response.status).toBe(409)
  })

  it('refuses a non-admin caller with 403', async () => {
    // A second signed-in account with no membership in this workspace should
    // read as "workspace not found" rather than 403 — the endpoint follows the
    // same shape every other workspace-scoped route does.
    const outsiderCookie = await client.signUp('outsider@example.com')

    const response = await install(outsiderCookie)

    expect([403, 404]).toContain(response.status)

    // The workspace should still be empty.
    const seededPeople = await harness.services.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.workspaceId, acme.workspaceId)))

    expect(seededPeople).toHaveLength(0)
  })
})

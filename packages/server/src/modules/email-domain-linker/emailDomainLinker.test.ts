import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { companies } from '../companies/schema.ts'
import { coreModules } from '../core.ts'
import { positions } from '../positions/schema.ts'

/** `POST /v1/workspaces/:id/relink-email-domains` against real Postgres. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('email-domain relinker', () => {
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

  async function createPerson(body: Record<string, unknown>, cookie = acme.cookie): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body, cookie })

    if (response.status !== 201) {
      throw new Error(`Creating a person answered ${String(response.status)}: ${await response.text()}`)
    }

    return readString(await response.json(), 'id')
  }

  async function createCompany(
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<string> {
    const response = await client.send('POST', '/v1/companies', { body, cookie })

    if (response.status !== 201) {
      throw new Error(`Creating a company answered ${String(response.status)}: ${await response.text()}`)
    }

    return readString(await response.json(), 'id')
  }

  async function relink(
    workspaceId: string,
    cookie = acme.cookie,
  ): Promise<Response> {
    return client.send('POST', `/v1/workspaces/${workspaceId}/relink-email-domains`, {
      body: {},
      cookie,
    })
  }

  async function positionsFor(personId: string): Promise<{ readonly companyId: string; readonly title: string }[]> {
    const rows = await database.db.select().from(positions).where(eq(positions.personId, personId))
    return rows.map((row) => ({ companyId: row.companyId, title: row.title }))
  }

  it('links People whose email domain matches a Company that predates them', async () => {
    // Set up a scenario that the auto-linker would not have caught: create the
    // person BEFORE the company (person-side listener fires; nothing to match)
    // then create the company via a raw insert to bypass the company-side
    // sweep. In practice this state exists for any workspace that predates the
    // auto-linker.
    const companyId = await createCompany({ name: 'Analytical Engines' })
    const personId = await createPerson({ name: 'Ada', email: 'ada@analytical.example' })

    // Now set the domain on the company via a repo-level write that does not
    // route through the service, mimicking data written before the auto-linker
    // existed. Using the API PATCH would trigger the sweep and defeat the
    // test's purpose.
    await database.db
      .update(companies)
      .set({ domain: 'analytical.example' })
      .where(eq(companies.id, companyId))

    expect(await positionsFor(personId)).toEqual([])

    const response = await relink(acme.workspaceId)
    const body = readRecord(await response.json())

    expect(response.status).toBe(200)
    expect(body.companies_scanned).toBe(1)
    expect(body.positions_created).toBe(1)
    expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
  })

  it('is idempotent — a second run adds nothing', async () => {
    const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
    const personId = await createPerson({ name: 'Ada', email: 'ada@analytical.example' })

    // The create paths already ran the auto-linker in the same transaction.
    expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])

    const first = readRecord(await (await relink(acme.workspaceId)).json())
    const second = readRecord(await (await relink(acme.workspaceId)).json())

    // Both scans see the one company, neither adds anything on top of the
    // link already there.
    expect(first.companies_scanned).toBe(1)
    expect(first.positions_created).toBe(0)
    expect(second.companies_scanned).toBe(1)
    expect(second.positions_created).toBe(0)
    expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
  })

  it('skips consumer email hosts even in the bulk sweep', async () => {
    await createCompany({ name: 'Gmail Inc', domain: 'gmail.com' })
    const personId = await createPerson({ name: 'Ada', email: 'ada@gmail.com' })

    const response = readRecord(await (await relink(acme.workspaceId)).json())

    // The Company is scanned (it has a domain) but the sweep refuses to attach
    // consumer addresses.
    expect(response.companies_scanned).toBe(1)
    expect(response.positions_created).toBe(0)
    expect(await positionsFor(personId)).toEqual([])
  })

  it('reports zero when nothing carries a domain', async () => {
    await createCompany({ name: 'Analytical Engines' })
    await createPerson({ name: 'Ada' })

    const response = readRecord(await (await relink(acme.workspaceId)).json())

    expect(response.companies_scanned).toBe(0)
    expect(response.positions_created).toBe(0)
  })

  it('refuses an outsider without membership', async () => {
    // Consistent with the sample-data endpoint: an account with no membership
    // reads as "workspace not found" rather than 403.
    const outsiderCookie = await client.signUp('outsider@example.com')

    const response = await relink(acme.workspaceId, outsiderCookie)

    expect([403, 404]).toContain(response.status)
  })

  it('refuses an owner of a different workspace', async () => {
    const initech = await client.owner('grace@example.com', 'initech')

    const response = await relink(acme.workspaceId, initech.cookie)

    expect([403, 404]).toContain(response.status)
  })

  it('does not sweep across workspaces', async () => {
    // acme carries a company on the domain; initech carries the matching person.
    // The sweep on acme's workspace must not attach initech's person.
    await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

    const initech = await client.owner('grace@example.com', 'initech')
    const theirPersonId = await createPerson(
      { name: 'Grace', email: 'grace@analytical.example' },
      initech.cookie,
    )

    await relink(acme.workspaceId)

    expect(await positionsFor(theirPersonId)).toEqual([])
  })
})

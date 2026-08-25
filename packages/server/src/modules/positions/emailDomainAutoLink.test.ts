import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { activities } from '../activities/schema.ts'
import { coreModules } from '../core.ts'
import { positions } from './schema.ts'

/**
 * The email-domain auto-linker: when a Person's email domain matches a workspace
 * Company, a titleless Position joins them. Runs inline in the emitting
 * transaction on both sides — a person write or a company write — so the response
 * to the same request already reflects the link. End-to-end against real
 * Postgres.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('email-domain auto-link', () => {
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

  async function updatePerson(
    id: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<void> {
    const response = await client.send('PATCH', `/v1/people/${id}`, { body, cookie })

    if (response.status !== 200) {
      throw new Error(`Updating a person answered ${String(response.status)}: ${await response.text()}`)
    }
  }

  async function updateCompany(
    id: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<void> {
    const response = await client.send('PATCH', `/v1/companies/${id}`, { body, cookie })

    if (response.status !== 200) {
      throw new Error(`Updating a company answered ${String(response.status)}: ${await response.text()}`)
    }
  }

  async function positionsFor(personId: string): Promise<{ readonly companyId: string; readonly title: string }[]> {
    const rows = await database.db.select().from(positions).where(eq(positions.personId, personId))
    return rows.map((row) => ({ companyId: row.companyId, title: row.title }))
  }

  describe('person-side', () => {
    it('creates a titleless Position when a new Person\'s email domain matches a workspace Company', async () => {
      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })

      // Sync: the Position is already there without draining anything.
      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })

    it('creates the link when a Person is updated to add a matching email', async () => {
      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const personId = await createPerson({ name: 'Ada Lovelace' })

      expect(await positionsFor(personId)).toEqual([])

      await updatePerson(personId, { email: 'ada@analytical.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })

    it('does nothing when no Company in the workspace holds that domain', async () => {
      await createCompany({ name: 'Analytical Engines' })
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })

      expect(await positionsFor(personId)).toEqual([])
    })

    it('skips consumer email domains', async () => {
      await createCompany({ name: 'Gmail Inc', domain: 'gmail.com' })
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@gmail.com' })

      expect(await positionsFor(personId)).toEqual([])
    })

    it('does not add a second Position when the Person already holds one at that Company', async () => {
      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const personId = await createPerson({ name: 'Ada Lovelace' })

      const linkResponse = await client.send('POST', '/v1/positions', {
        body: { person_id: personId, company_id: companyId, title: 'Chief Mathematician' },
        cookie: acme.cookie,
      })
      expect(linkResponse.status).toBe(201)

      await updatePerson(personId, { email: 'ada@analytical.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId, title: 'Chief Mathematician' }])
    })

    it('does not fire on updates that leave the email alone', async () => {
      await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const personId = await createPerson({ name: 'Ada Lovelace' })
      // The person has no email, so a rename cannot match anything; but even a
      // person WITH a matching email should be untouched by a rename, because
      // the update path only reacts to `email` in `changed`.
      await updatePerson(personId, { name: 'A. Lovelace' })

      expect(await positionsFor(personId)).toEqual([])
    })

    it('leaves an earlier auto-link in place when the email later changes to a different domain', async () => {
      const first = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const second = await createCompany({ name: 'Second Corp', domain: 'second.example' })
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId: first, title: '' }])

      await updatePerson(personId, { email: 'ada@second.example' })

      const rows = await positionsFor(personId)
      expect(rows).toHaveLength(2)
      expect(rows).toEqual(
        expect.arrayContaining([
          { companyId: first, title: '' },
          { companyId: second, title: '' },
        ]),
      )
    })

    it('does not link across workspace boundaries', async () => {
      await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

      const initech = await client.owner('grace@example.com', 'initech')
      const theirPersonId = await createPerson(
        { name: 'Grace Hopper', email: 'grace@analytical.example' },
        initech.cookie,
      )

      expect(await positionsFor(theirPersonId)).toEqual([])
    })

    it('is idempotent under repeated identical email updates', async () => {
      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      // A second identical PATCH short-circuits in the people service (no
      // changed fields) so no re-link attempt runs. Either way, the assertion
      // is a single Position at that pair.
      await updatePerson(personId, { email: 'ada@analytical.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })

    it('does not link a subdomain email to a Company at the parent domain', async () => {
      // `alex@sub.example` does not share a Company with domain `example`. The
      // person-side extraction takes exactly the string after `@`, which is a
      // subdomain here; the company row on the parent domain does not match.
      await createCompany({ name: 'Example Co', domain: 'example.com' })
      const personId = await createPerson({ name: 'Alex', email: 'alex@sub.example.com' })

      expect(await positionsFor(personId)).toEqual([])
    })
  })

  describe('company-side', () => {
    it('sweeps a matching Person when a Company is created with a domain later than the Person', async () => {
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      // No company yet — no link.
      expect(await positionsFor(personId)).toEqual([])

      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

      // Sync: the sweep completed inside the company create transaction.
      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })

    it('sweeps a matching Person when a Company\'s domain is later set to match', async () => {
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      const companyId = await createCompany({ name: 'Analytical Engines' })
      expect(await positionsFor(personId)).toEqual([])

      await updateCompany(companyId, { domain: 'analytical.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })

    it('does not sweep on updates that leave the domain alone', async () => {
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
      // The initial create already linked them. Confirm a plain rename does
      // not re-attempt anything (and does not, e.g., double-insert).
      const before = await positionsFor(personId)

      await updateCompany(companyId, { name: 'Analytical Engines Ltd' })

      expect(await positionsFor(personId)).toEqual(before)
    })

    it('sweeps every matching Person in the workspace', async () => {
      const first = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      const second = await createPerson({ name: 'Charles Babbage', email: 'charles@analytical.example' })
      const third = await createPerson({ name: 'Grace Hopper', email: 'grace@elsewhere.example' })

      const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

      expect(await positionsFor(first)).toEqual([{ companyId, title: '' }])
      expect(await positionsFor(second)).toEqual([{ companyId, title: '' }])
      // Grace's email is at a different domain, so nothing links.
      expect(await positionsFor(third)).toEqual([])
    })

    it('does not touch a Person who already holds a titled Position at this Company', async () => {
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })
      // Create a titled position first (no domain, so no auto-link happens yet).
      const holdingCompanyId = await createCompany({ name: 'Analytical Engines' })
      const linkResponse = await client.send('POST', '/v1/positions', {
        body: {
          person_id: personId,
          company_id: holdingCompanyId,
          title: 'Chief Mathematician',
        },
        cookie: acme.cookie,
      })
      expect(linkResponse.status).toBe(201)

      // Now set the domain — the sweep should see the existing titled Position
      // and skip.
      await updateCompany(holdingCompanyId, { domain: 'analytical.example' })

      expect(await positionsFor(personId)).toEqual([
        { companyId: holdingCompanyId, title: 'Chief Mathematician' },
      ])
    })

    it('skips consumer email domains on the company side too', async () => {
      // A Company entered by mistake against a consumer host must not attach
      // every unrelated address in the workspace.
      const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@gmail.com' })
      await createCompany({ name: 'Gmail Inc', domain: 'gmail.com' })

      expect(await positionsFor(personId)).toEqual([])
    })

    it('does not sweep across workspace boundaries', async () => {
      const initech = await client.owner('grace@example.com', 'initech')
      const theirPersonId = await createPerson(
        { name: 'Grace Hopper', email: 'grace@analytical.example' },
        initech.cookie,
      )

      // Company created in the acme workspace with the domain Grace uses.
      // Grace lives in initech, so nothing should link.
      await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })

      expect(await positionsFor(theirPersonId)).toEqual([])
    })

    it('matches email domain case-insensitively', async () => {
      // The email column is `citext`, and the sweep lowercases the domain
      // literal, so an address stored in mixed case still matches a Company
      // domain stored in another mixed case.
      const personId = await createPerson({ name: 'Ada', email: 'Ada@Analytical.Example' })
      const companyId = await createCompany({ name: 'Analytical', domain: 'ANALYTICAL.example' })

      expect(await positionsFor(personId)).toEqual([{ companyId, title: '' }])
    })
  })

  it('records a timeline entry attributed to the system side effect', async () => {
    const companyId = await createCompany({ name: 'Analytical Engines', domain: 'analytical.example' })
    const personId = await createPerson({ name: 'Ada Lovelace', email: 'ada@analytical.example' })

    const personRows = await database.db
      .select()
      .from(activities)
      .where(eq(activities.targetId, personId))

    const link = personRows.find(
      (row) => row.actorLabel === 'Email domain match' && row.action.startsWith('linked to'),
    )

    expect(link).toBeDefined()
    expect(link?.detail).toBe('Analytical Engines')

    const companyRows = await database.db
      .select()
      .from(activities)
      .where(eq(activities.targetId, companyId))
    expect(
      companyRows.some(
        (row) => row.actorLabel === 'Email domain match' && row.detail === 'Ada Lovelace',
      ),
    ).toBe(true)
  })
})

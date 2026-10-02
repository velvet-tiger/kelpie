import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

/** `GET /v1/tags` against real Postgres. Every tag goes in through the API. */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('tags', () => {
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

  async function create(
    path: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<void> {
    const response = await client.send('POST', path, { body, cookie })

    expect(response.status, `POST ${path} answered ${await response.clone().text()}`).toBe(201)
  }

  async function tags(query = '', cookie = acme.cookie): Promise<Record<string, unknown>> {
    const response = await client.send('GET', `/v1/tags${query}`, { cookie })

    expect(response.status, `GET /v1/tags${query} answered ${await response.clone().text()}`).toBe(
      200,
    )

    return readRecord(await response.json())
  }

  it('counts each tag across records, most used first', async () => {
    await create('/v1/people', { name: 'Ada', tags: ['investor', 'waitlist'] })
    await create('/v1/people', { name: 'Grace', tags: ['waitlist'] })
    await create('/v1/companies', { name: 'Northwind', tags: ['customer', 'waitlist'] })

    expect(await tags()).toEqual({
      query: null,
      limit: 20,
      tags: [
        { tag: 'waitlist', count: 3 },
        { tag: 'customer', count: 1 },
        { tag: 'investor', count: 1 },
      ],
    })
  })

  it('narrows to the named target types', async () => {
    await create('/v1/people', { name: 'Ada', tags: ['investor'] })
    await create('/v1/companies', { name: 'Northwind', tags: ['customer'] })

    const body = await tags('?target_type=company')

    expect(body.tags).toEqual([{ tag: 'customer', count: 1 }])
  })

  it('suggests a tag only a form sets, at a count of zero', async () => {
    await create('/v1/forms', {
      name: 'Waitlist',
      fields: [{ label: 'Email', type: 'email', map_to: 'person.email', required: true }],
      person_tags: ['early-access'],
    })

    expect((await tags('?target_type=person')).tags).toEqual([{ tag: 'early-access', count: 0 }])
    expect((await tags('?target_type=company')).tags).toEqual([])
  })

  it('filters by a case-insensitive substring and treats % as a character', async () => {
    await create('/v1/people', { name: 'Ada', tags: ['Seed Investor', 'advisor', '100%'] })

    expect((await tags('?q=INVEST')).tags).toEqual([{ tag: 'Seed Investor', count: 1 }])
    expect((await tags('?q=%25')).tags).toEqual([{ tag: '100%', count: 1 }])
  })

  it('caps the list with ?limit=', async () => {
    await create('/v1/people', { name: 'Ada', tags: ['a', 'b', 'c'] })

    const body = await tags('?limit=2')

    expect(body.limit).toBe(2)
    expect(body.tags).toEqual([
      { tag: 'a', count: 1 },
      { tag: 'b', count: 1 },
    ])
  })

  it('never shows another workspace its tags', async () => {
    await create('/v1/people', { name: 'Ada', tags: ['acme-only'] })

    const globex = await client.owner('grace@example.com')

    expect((await tags('', globex.cookie)).tags).toEqual([])
  })

  it('refuses an unknown target type', async () => {
    const response = await client.send('GET', '/v1/tags?target_type=role', { cookie: acme.cookie })

    expect(response.status).toBe(422)
  })

  it('refuses a caller with no credentials', async () => {
    const response = await client.send('GET', '/v1/tags')

    expect(response.status).toBe(401)
  })
})

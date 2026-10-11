import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import { createTestClient, readCursor, readList, readRecord } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'

/** Paging of `GET /v1/custom_fields` against real Postgres. The default sort is `sort_order`, a whole number. */

const connectionString = testDatabaseUrl(process.env)

/** A cursor as the API encodes one, with a position this API never issued. */
function forgedCursor(value: string): string {
  return Buffer.from(JSON.stringify({ sort: 'sort_order', value, id: 'x' }), 'utf8').toString('base64url')
}

describe.skipIf(connectionString === undefined)('custom fields paging', () => {
  let database: TestDatabase
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
    const harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()

    for (const key of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      const response = await client.send('POST', '/v1/custom_fields', {
        cookie: acme.cookie,
        body: { object_type: 'person', key, label: key, type: 'text' },
      })

      expect(response.status).toBe(201)
    }
  })

  it('pages by sort_order without repeating or losing a row', async () => {
    const seen: Record<string, unknown>[] = []
    let cursor: string | null = null
    let requests = 0

    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`
      const response = await client.send('GET', `/v1/custom_fields${query}`, { cookie: acme.cookie })
      const payload: unknown = await response.json()

      expect(response.status).toBe(200)
      seen.push(...readList(payload))
      cursor = readCursor(payload)
      requests += 1
    } while (cursor !== null && requests < 10)

    expect(requests).toBe(3)
    expect(seen.map((row) => row.key)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
    expect(seen.map((row) => row.sort_order)).toEqual([0, 1, 2, 3, 4])
  })

  it('pages by sort_order from the highest down', async () => {
    const first: unknown = await (
      await client.send('GET', '/v1/custom_fields?sort=-sort_order&limit=3', { cookie: acme.cookie })
    ).json()
    const second: unknown = await (
      await client.send(
        'GET',
        `/v1/custom_fields?sort=-sort_order&limit=3&cursor=${encodeURIComponent(String(readCursor(first)))}`,
        { cookie: acme.cookie },
      )
    ).json()

    expect(readList(first).map((row) => row.key)).toEqual(['echo', 'delta', 'charlie'])
    expect(readList(second).map((row) => row.key)).toEqual(['bravo', 'alpha'])
    expect(readCursor(second)).toBeNull()
  })

  it('answers 422 to a cursor whose position is not a whole number', async () => {
    for (const value of ['abc', '1.5', 'NaN', 'Infinity']) {
      const response = await client.send('GET', `/v1/custom_fields?cursor=${forgedCursor(value)}`, {
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status, value).toBe(422)
      expect(readRecord(body.error).code, value).toBe('validation_failed')
    }
  })
})

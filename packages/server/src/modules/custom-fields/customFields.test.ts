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
function forgedCursor(sort: string, value: string, id = 'x'): string {
  return Buffer.from(JSON.stringify({ sort, value, id }), 'utf8').toString('base64url')
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
      const response = await client.send('GET', `/v1/custom_fields?cursor=${forgedCursor('sort_order', value)}`, {
        cookie: acme.cookie,
      })
      const body = readRecord(await response.json())

      expect(response.status, value).toBe(422)
      expect(readRecord(body.error).code, value).toBe('validation_failed')
    }
  })

  it('answers 422 to a cursor whose position is outside the range of a Postgres integer', async () => {
    for (const value of ['2147483648', '-2147483649', '99999999999', '-99999999999', '1e20', '1e308', '9007199254740993']) {
      const response = await client.send('GET', `/v1/custom_fields?cursor=${forgedCursor('sort_order', value)}`, {
        cookie: acme.cookie,
      })

      expect(response.status, value).toBe(422)
    }
  })

  it('reads a cursor at each end of that range', async () => {
    const send = (value: string): Promise<Response> =>
      client.send('GET', `/v1/custom_fields?cursor=${forgedCursor('sort_order', value)}`, { cookie: acme.cookie })
    const fromLowest = await send('-2147483648')
    const fromHighest = await send('2147483647')

    expect(fromLowest.status).toBe(200)
    expect(readList(await fromLowest.json())).toHaveLength(5)
    expect(fromHighest.status).toBe(200)
    expect(readList(await fromHighest.json())).toEqual([])
  })

  it('answers 422 to a cursor with a NUL character in its id or in a text position', async () => {
    const inId = await client.send('GET', `/v1/custom_fields?cursor=${forgedCursor('sort_order', '1', 'x\u0000')}`, {
      cookie: acme.cookie,
    })
    const inValue = await client.send(
      'GET',
      `/v1/custom_fields?sort=label&cursor=${forgedCursor('label', 'a\u0000')}`,
      { cookie: acme.cookie },
    )

    expect(inId.status).toBe(422)
    expect(inValue.status).toBe(422)
  })

  it('answers 422 to a cursor whose timestamp is outside year 1 to year 9999', async () => {
    for (const value of ['-271821-04-20T00:00:00.000Z', '0000-12-31T23:59:59.999Z', '+010000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z']) {
      const response = await client.send(
        'GET',
        `/v1/custom_fields?sort=created_at&cursor=${forgedCursor('created_at', value)}`,
        { cookie: acme.cookie },
      )

      expect(response.status, value).toBe(422)
    }
  })
})

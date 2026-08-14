import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from './testing/app.ts'
import type { TestApp } from './testing/app.ts'
import { createTestClient, readString } from './testing/client.ts'
import type { TestClient } from './testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from './testing/database.ts'
import type { TestDatabase } from './testing/database.ts'
import { TEST_ENVIRONMENT } from './testing/environment.ts'
import { createTestServices } from './testing/services.ts'
import { coreModules } from './modules/core.ts'
import type { KelpieModule } from './runtime/module.ts'

/**
 * The operator surface against real auth: the guard is a security boundary, so
 * what matters is what a stranger, a key holder, and a non-operator observe.
 *
 * Core ships no operator routes, so the module under test contributes one. That
 * also asserts the contribution path end to end: `operatorRoutes` to registry to
 * `createApp`'s mount.
 */

const connectionString = testDatabaseUrl(process.env)

const consoleModule: KelpieModule = {
  id: 'console',
  register(context) {
    context.operatorRoutes((router) => {
      router.get('/ping', (requestContext) => requestContext.json({ pong: true }))
    })

    return Promise.resolve()
  },
}

describe.skipIf(connectionString === undefined)('operator surface', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient

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
      modules: [...coreModules, consoleModule],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
      superuserEmails: new Set(['ada@example.com']),
    })
    client = createTestClient(harness.app, database.db)
  })

  it('collects operator routers apart from the rest', () => {
    expect(harness.contributions.operatorRouters.map((entry) => entry.moduleId)).toEqual(['console'])
    expect(harness.contributions.routers.map((entry) => entry.moduleId)).not.toContain('console')
  })

  it('answers 401 with no credentials', async () => {
    const response = await harness.app.request('/operator/api/ping')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('refuses an API key, even one belonging to an operator account', async () => {
    const owner = await client.owner('ada@example.com')
    const minted = await client.send('POST', '/v1/api-keys', {
      body: { kind: 'workspace', name: 'Support key' },
      cookie: owner.cookie,
    })
    expect(minted.status).toBe(201)
    const secret = readString(await minted.json(), 'secret')

    const response = await client.send('GET', '/operator/api/ping', { bearer: secret })

    expect(response.status).toBe(403)
  })

  it('refuses a signed-in account that is not on the allowlist', async () => {
    const cookie = await client.signUp('grace@example.com')
    const response = await client.send('GET', '/operator/api/ping', { cookie })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  it('serves a contributed route to an operator, workspace or not', async () => {
    // signUp only: no workspace exists, which must not matter here.
    const cookie = await client.signUp('ada@example.com')
    const response = await client.send('GET', '/operator/api/ping', { cookie })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pong: true })
  })

  it('matches the allowlist case-insensitively', async () => {
    const cookie = await client.signUp('Ada@Example.com')
    const response = await client.send('GET', '/operator/api/ping', { cookie })

    expect(response.status).toBe(200)
  })

  it('does not serve the contributed route under /v1', async () => {
    const owner = await client.owner('ada@example.com')
    const response = await client.send('GET', '/v1/ping', { cookie: owner.cookie })

    expect(response.status).toBe(404)
  })

  it('answers the JSON 404 for an unknown operator path, after the guard', async () => {
    const cookie = await client.signUp('ada@example.com')
    const response = await client.send('GET', '/operator/api/nothing-here', { cookie })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('locks everyone out when the allowlist is empty', async () => {
    const closed = await createTestApp({
      modules: [...coreModules, consoleModule],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    const closedClient = createTestClient(closed.app, database.db)

    const cookie = await closedClient.signUp('ada@example.com')
    const response = await closedClient.send('GET', '/operator/api/ping', { cookie })

    expect(response.status).toBe(403)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { isScopeExemptRoute, resolveRestScope } from '../../lib/apiKeyScopes.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { ModuleBootError } from '../../runtime/order.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { createAiModule } from '../ai/index.ts'
import { coreModules } from '../core.ts'

/**
 * Scope enforcement fails closed: a `/v1` route with no scope rule is refused
 * to a scoped key. Two things are proved here, against real Postgres.
 *
 * Every route the core modules and the `ai` module register has a scope rule
 * or is in `EXEMPT_ROUTES`. A new route with neither fails here until somebody
 * decides which scope it needs. A module outside this repository is not here.
 *
 * A module route gets the scope its module declares with `routeScopes`, and
 * no scoped key reaches a route that declared none.
 */

const connectionString = testDatabaseUrl(process.env)

/**
 * Every registered `/v1` route that needs no scope, and why. A route is added
 * here only when no API key can use it at all.
 */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  // No credentials: anybody may call these.
  'POST /v1/public/workspaces/:workspaceId/forms/:slug/submit': 'public',
  'GET /v1/public/workspaces/:workspaceId/forms/:formId/token': 'public',
  'GET /v1/public/workspaces/:workspaceId/forms/:formId/embed': 'public',
  'GET /v1/public/config': 'public',
  // Signing in and the signed-in person's own account. A key is not a person.
  'POST /v1/auth/signup': 'auth',
  'POST /v1/auth/login': 'auth',
  'POST /v1/auth/logout': 'auth',
  'GET /v1/auth/me': 'auth',
  'GET /v1/auth/workspaces': 'auth',
  'POST /v1/auth/workspace': 'auth',
  'GET /v1/auth/sessions': 'auth',
  'DELETE /v1/auth/sessions/:id': 'auth',
  'PATCH /v1/auth/password': 'auth',
  'POST /v1/auth/password-reset': 'auth',
  'POST /v1/auth/password-reset/confirm': 'auth',
  'POST /v1/auth/verify-email': 'auth',
  'POST /v1/auth/verify-email/confirm': 'auth',
  'GET /v1/account': 'account',
  'PATCH /v1/account': 'account',
  'GET /v1/account/preferences': 'account',
  'PATCH /v1/account/preferences': 'account',
  // A key is bound to one workspace and cannot make or join another.
  'POST /v1/workspaces': 'session only',
  'POST /v1/invites/accept': 'session only',
  // The service refuses every bearer credential.
  'GET /v1/oauth/requests/:id': 'session only',
  'POST /v1/oauth/requests/:id/approve': 'session only',
  'POST /v1/oauth/requests/:id/deny': 'session only',
  'GET /v1/oauth/grants': 'session only',
  'DELETE /v1/oauth/grants/:id': 'session only',
  'DELETE /v1/oauth/connections/:id': 'session only',
}

/** A module as one outside core is written: two routes, one with a declared scope. */
const widgetsModule: KelpieModule = {
  id: 'widgets',
  structural: true,
  register(context) {
    context.routes((router) => {
      router.get('/widgets/:id', (requestContext) => requestContext.json({ id: requestContext.req.param('id') }))
      router.post('/widgets', (requestContext) => requestContext.json({ created: true }, 201))
      router.get('/widgets-undeclared', (requestContext) => requestContext.json({ ok: true }))
    })

    context.routeScopes([
      { methods: ['GET'], path: '/widgets/:id', scope: 'companies:read' },
      { methods: ['POST'], path: '/widgets', scope: 'companies:write' },
      // Core's rule for this path is read first, so this one changes nothing.
      { methods: ['GET'], path: '/people', scope: 'tags:read' },
    ])

    return Promise.resolve()
  },
}

describe.skipIf(connectionString === undefined)('scope rules cover every route', () => {
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

  async function appWith(modules: readonly KelpieModule[]): Promise<TestApp> {
    return createTestApp({
      modules: [...coreModules, ...modules],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await appWith([widgetsModule])
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

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

  async function errorMessage(response: Response): Promise<string> {
    return readString(readRecord(await response.json()).error, 'message')
  }

  const NO_RULE_MESSAGE =
    'This API key is limited to its scopes, and no scope is declared for this route. Use a key with full access'

  describe('the routes in this repository', () => {
    it('gives every /v1 route a scope rule or a named exemption, and no exemption is stale', async () => {
      // The `ai` module is the one optional module here. Only its routes are
      // read, so its own tables need not exist in this database.
      const app = (await appWith([createAiModule({ keyMode: 'workspace', providers: {} })])).app
      const routes = [
        ...new Set(
          app.routes
            // `ALL` is middleware, which answers nothing on its own.
            .filter((route) => route.path.startsWith('/v1/') && route.method !== 'ALL')
            .map((route) => `${route.method} ${route.path}`),
        ),
      ]

      expect(routes.length).toBeGreaterThan(150)

      const exempt: string[] = []
      const withoutRule: string[] = []

      for (const route of routes) {
        const [method = '', path = ''] = route.split(' ')
        const concrete = path.replaceAll(/:[A-Za-z]+/gu, 'x')

        if (isScopeExemptRoute(method, concrete)) {
          exempt.push(route)
        } else if (resolveRestScope(method, concrete) === null) {
          withoutRule.push(route)
        }
      }

      expect(withoutRule).toEqual([])
      expect(exempt.sort()).toEqual(Object.keys(EXEMPT_ROUTES).sort())
    })
  })

  describe('a route with no scope rule', () => {
    it('is refused to a scoped key, whatever scopes it has', async () => {
      for (const scopes of [['companies:read'], ['read:all', 'write:all'], ['admin']]) {
        const response = await client.send('GET', '/v1/widgets-undeclared', { bearer: await key(scopes) })

        expect(response.status, scopes.join(',')).toBe(403)
        expect(await errorMessage(response)).toBe(NO_RULE_MESSAGE)
      }
    })

    it('is open to a full-access key and to a session, as before', async () => {
      expect((await client.send('GET', '/v1/widgets-undeclared', { bearer: await key([]) })).status).toBe(200)
      expect((await client.send('GET', '/v1/widgets-undeclared', { cookie: acme.cookie })).status).toBe(200)
    })

    it('answers a key that is not valid with 401', async () => {
      const response = await client.send('GET', '/v1/widgets-undeclared', { bearer: 'kp_ws_not_a_key' })

      expect(response.status).toBe(401)
    })

    it('refuses a path that no route answers too, and still answers 404 to a full-access key', async () => {
      expect((await client.send('GET', '/v1/no-such-thing', { bearer: await key(['read:all']) })).status).toBe(403)
      expect((await client.send('GET', '/v1/no-such-thing', { bearer: await key([]) })).status).toBe(404)
      expect((await client.send('GET', '/v1/no-such-thing', { cookie: acme.cookie })).status).toBe(404)
    })
  })

  describe('a module route with a declared scope', () => {
    it('needs that scope from a scoped key, for each declared method', async () => {
      const reader = await key(['companies:read'])
      const writer = await key(['companies:write'])
      const other = await key(['people:write'])

      expect((await client.send('GET', '/v1/widgets/w1', { bearer: reader })).status).toBe(200)
      expect((await client.send('GET', '/v1/widgets/w1', { bearer: writer })).status).toBe(200)
      expect((await client.send('POST', '/v1/widgets', { body: {}, bearer: writer })).status).toBe(201)

      const noWrite = await client.send('POST', '/v1/widgets', { body: {}, bearer: reader })

      expect(noWrite.status).toBe(403)
      expect(await errorMessage(noWrite)).toBe('This API key does not have the companies:write scope')
      expect((await client.send('GET', '/v1/widgets/w1', { bearer: other })).status).toBe(403)
    })

    it('stays open to a full-access key and to a session', async () => {
      expect((await client.send('GET', '/v1/widgets/w1', { bearer: await key([]) })).status).toBe(200)
      expect((await client.send('GET', '/v1/widgets/w1', { cookie: acme.cookie })).status).toBe(200)
    })

    it('cannot change the scope of a core route', async () => {
      expect((await client.send('GET', '/v1/people', { bearer: await key(['tags:read']) })).status).toBe(403)
      expect((await client.send('GET', '/v1/people', { bearer: await key(['people:read']) })).status).toBe(200)
    })

    it('fails boot on a path it cannot read, and names the module', async () => {
      const broken: KelpieModule = {
        id: 'broken-scopes',
        structural: true,
        register(context) {
          context.routeScopes([{ methods: ['GET'], path: '/*', scope: 'workspace:read' }])

          return Promise.resolve()
        },
      }

      await expect(appWith([broken])).rejects.toThrow(ModuleBootError)
      await expect(appWith([broken])).rejects.toThrow(/module "broken-scopes": the scope rule path "\/\*"/u)
    })
  })

  describe('HEAD', () => {
    it('needs the scope the GET needs', async () => {
      const head = (path: string, bearer: string): Promise<Response> =>
        Promise.resolve(harness.app.request(path, { method: 'HEAD', headers: { Authorization: `Bearer ${bearer}` } }))

      expect((await head('/v1/people', await key(['companies:read']))).status).toBe(403)
      expect((await head('/v1/people', await key(['people:read']))).status).toBe(200)
      expect((await head('/v1/widgets/w1', await key(['people:read']))).status).toBe(403)
      expect((await head('/v1/widgets/w1', await key(['companies:read']))).status).toBe(200)
    })
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { WORKSPACE_ACCESS } from './capabilities.ts'

/**
 * The blanket `workspace.access` gate (`workspaceAccessMiddleware.ts`), the
 * one core change the operator surface's suspend action depends on
 * (`kelpie-cloud`). No module in `coreModules` denies this capability, so
 * this suite supplies its own `GrantProvider` — the same seam a `kelpie-cloud`
 * module fills in with a real one — to prove the gate itself, independent of
 * anything cloud-only.
 */

const connectionString = testDatabaseUrl(process.env)

describe.skipIf(connectionString === undefined)('workspace access gate', () => {
  let database: TestDatabase

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
  })

  describe('with a provider denying one workspace', () => {
    let harness: TestApp
    let client: TestClient
    let blocked: TestOwner
    let open: TestOwner
    /** Minted before `deniedWorkspaceId` is set: a suspended workspace keeps whatever keys it minted earlier. */
    let blockedWorkspaceKey: string
    let deniedWorkspaceId: string | undefined

    beforeEach(async () => {
      deniedWorkspaceId = undefined

      const entitlements: EntitlementRegistry = createEntitlementRegistry()
      entitlements.provide((workspaceId, capability) =>
        Promise.resolve(
          capability.name === WORKSPACE_ACCESS.name && workspaceId === deniedWorkspaceId
            ? { kind: 'flag', granted: false }
            : undefined,
        ),
      )

      harness = await createTestApp({
        modules: coreModules,
        environment: TEST_ENVIRONMENT,
        services: createTestServices({ db: database.db }),
        entitlements,
      })
      client = createTestClient(harness.app, harness.services.db)

      blocked = await client.owner('blocked@example.com', 'blocked')
      open = await client.owner('open@example.com', 'open')

      const minted = await client.send('POST', '/v1/api-keys', {
        cookie: blocked.cookie,
        body: { name: 'agent', kind: 'workspace' },
      })
      blockedWorkspaceKey = readString(await minted.json(), 'secret')

      deniedWorkspaceId = blocked.workspaceId
    })

    it('blocks a REST call from the blocked workspace', async () => {
      const response = await client.send('GET', '/v1/people', { cookie: blocked.cookie })

      expect(response.status).toBe(403)
      expect(readRecord(readRecord(await response.json()).error).code).toBe('entitlement_required')
    })

    it('blocks a workspace API key belonging to the blocked workspace', async () => {
      const response = await client.send('GET', '/v1/people', { bearer: blockedWorkspaceKey })

      expect(response.status).toBe(403)
    })

    it('refuses to mint a new key while blocked, the same as any other /v1 write', async () => {
      const response = await client.send('POST', '/v1/api-keys', {
        cookie: blocked.cookie,
        body: { name: 'second key', kind: 'workspace' },
      })

      expect(response.status).toBe(403)
    })

    it('blocks mcp calls from the blocked workspace', async () => {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${blockedWorkspaceKey}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })

      expect(response.status).toBe(403)
    })

    it('does not block a workspace the provider has no opinion on', async () => {
      const response = await client.send('GET', '/v1/people', { cookie: open.cookie })

      expect(response.status).toBe(200)
    })

    it('still allows the blocked workspace member to see their own account', async () => {
      const me = await client.send('GET', '/v1/auth/me', { cookie: blocked.cookie })
      const account = await client.send('GET', '/v1/account', { cookie: blocked.cookie })

      expect(me.status).toBe(200)
      expect(account.status).toBe(200)
    })

    it('still allows the blocked workspace member to sign out', async () => {
      const response = await client.send('POST', '/v1/auth/logout', { cookie: blocked.cookie })

      expect(response.status).toBe(204)
    })

    it('still allows the blocked workspace owner to delete the workspace', async () => {
      const response = await client.send('DELETE', `/v1/workspaces/${blocked.workspaceId}?slug=blocked`, {
        cookie: blocked.cookie,
      })

      expect(response.status).toBe(204)
    })

    it('keeps every other verb and sub-resource under /v1/workspaces/:id gated', async () => {
      const patch = await client.send('PATCH', `/v1/workspaces/${blocked.workspaceId}`, {
        cookie: blocked.cookie,
        body: { name: 'Renamed' },
      })
      const members = await client.send('GET', `/v1/workspaces/${blocked.workspaceId}/members`, {
        cookie: blocked.cookie,
      })

      expect(patch.status).toBe(403)
      expect(members.status).toBe(403)
    })
  })

  it('is inert with no provider registered, the open-source default', async () => {
    const harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    const client = createTestClient(harness.app, harness.services.db)
    const acme = await client.owner()

    const response = await client.send('GET', '/v1/people', { cookie: acme.cookie })

    expect(response.status).toBe(200)
  })
})

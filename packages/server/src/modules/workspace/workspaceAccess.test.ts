import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
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

      blocked = await client.owner('blocked@example.com')
      open = await client.owner('open@example.com')

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
      const response = await client.send('DELETE', `/v1/workspaces/${blocked.workspaceId}?name=Acme`, {
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

  it('lets a member of a blocked workspace list memberships and switch to another', async () => {
    let deniedWorkspaceId: string | undefined
    const entitlements: EntitlementRegistry = createEntitlementRegistry()
    entitlements.provide((workspaceId, capability) =>
      Promise.resolve(
        capability.name === WORKSPACE_ACCESS.name && workspaceId === deniedWorkspaceId
          ? { kind: 'flag', granted: false }
          : undefined,
      ),
    )

    const harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
      entitlements,
    })
    const client = createTestClient(harness.app, harness.services.db)
    const blocked = await client.owner('switch-away@example.com')
    const second = await client.send('POST', '/v1/workspaces', {
      cookie: blocked.cookie,
      body: { name: 'Other', timezone: 'UTC' },
    })
    expect(second.status).toBe(201)
    const otherId = readString(await second.json(), 'id')

    const back = await client.send('POST', '/v1/auth/workspace', {
      cookie: blocked.cookie,
      body: { workspace_id: blocked.workspaceId },
    })
    expect(back.status).toBe(200)

    deniedWorkspaceId = blocked.workspaceId

    const peopleWhileBlocked = await client.send('GET', '/v1/people', { cookie: blocked.cookie })
    expect(peopleWhileBlocked.status).toBe(403)

    const listed = await client.send('GET', '/v1/auth/workspaces', { cookie: blocked.cookie })
    expect(listed.status).toBe(200)

    const switched = await client.send('POST', '/v1/auth/workspace', {
      cookie: blocked.cookie,
      body: { workspace_id: otherId },
    })
    expect(switched.status).toBe(200)

    const peopleAfter = await client.send('GET', '/v1/people', { cookie: blocked.cookie })
    expect(peopleAfter.status).toBe(200)
  })

  describe('for a path that names a workspace', () => {
    let harness: TestApp
    let client: TestClient
    /** Owns the suspended workspace and the open one. */
    let cookie: string
    let suspendedId: string
    let openId: string
    let deniedWorkspaceId: string | undefined

    async function activate(workspaceId: string): Promise<void> {
      const switched = await client.send('POST', '/v1/auth/workspace', {
        cookie,
        body: { workspace_id: workspaceId },
      })

      expect(switched.status).toBe(200)
    }

    /** The starter Contact form of the active workspace. Read before the suspension starts. */
    async function contactForm(): Promise<{ id: string; slug: string }> {
      const listed = await client.send('GET', '/v1/forms', { cookie })
      const form = readList(await listed.json()).find((entry) => readString(entry, 'slug') === 'contact')

      if (form === undefined) {
        throw new Error('The workspace has no starter Contact form')
      }

      return { id: readString(form, 'id'), slug: readString(form, 'slug') }
    }

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

      const owner = await client.owner('both@example.com')
      cookie = owner.cookie
      suspendedId = owner.workspaceId

      // Creating a workspace moves the session into it.
      const second = await client.send('POST', '/v1/workspaces', {
        cookie,
        body: { name: 'Other', timezone: 'UTC' },
      })
      expect(second.status).toBe(201)
      openId = readString(await second.json(), 'id')
    })

    it('blocks a call on a suspended workspace from a session that is active in an open one', async () => {
      deniedWorkspaceId = suspendedId

      const members = await client.send('GET', `/v1/workspaces/${suspendedId}/members`, { cookie })
      const patch = await client.send('PATCH', `/v1/workspaces/${suspendedId}`, {
        cookie,
        body: { name: 'Renamed' },
      })
      const invite = await client.send('POST', `/v1/workspaces/${suspendedId}/invites`, {
        cookie,
        body: { email: 'grace@example.com', role: 'member' },
      })

      expect(members.status).toBe(403)
      expect(readRecord(readRecord(await members.json()).error).code).toBe('entitlement_required')
      expect(patch.status).toBe(403)
      expect(invite.status).toBe(403)

      // The session's own workspace is not suspended, and stays reachable.
      expect((await client.send('GET', '/v1/people', { cookie })).status).toBe(200)
    })

    it('reads the workspace id the way the router does, so an encoded id is not a way round', async () => {
      deniedWorkspaceId = suspendedId

      const encoded = `%${suspendedId.charCodeAt(0).toString(16)}${suspendedId.slice(1)}`
      const response = await client.send('GET', `/v1/workspaces/${encoded}/members`, { cookie })

      expect(response.status).toBe(403)
    })

    it('lets a call on an open workspace through from a session that is active in a suspended one', async () => {
      await activate(suspendedId)
      deniedWorkspaceId = suspendedId

      const members = await client.send('GET', `/v1/workspaces/${openId}/members`, { cookie })
      const people = await client.send('GET', '/v1/people', { cookie })

      expect(members.status).toBe(200)
      expect(people.status).toBe(403)
    })

    it('still lets the owner delete a suspended workspace that is not the active one', async () => {
      deniedWorkspaceId = suspendedId

      const response = await client.send('DELETE', `/v1/workspaces/${suspendedId}?name=Acme`, { cookie })

      expect(response.status).toBe(204)
    })

    it('answers a caller who does not belong to the suspended workspace as if it did not exist', async () => {
      const stranger = await client.owner('stranger@example.com')
      deniedWorkspaceId = suspendedId

      const response = await client.send('GET', `/v1/workspaces/${suspendedId}/members`, {
        cookie: stranger.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('answers a workspace key that names a different, suspended workspace as if it did not exist', async () => {
      const minted = await client.send('POST', '/v1/api-keys', {
        cookie,
        body: { name: 'agent', kind: 'workspace', full_access: true },
      })
      const openWorkspaceKey = readString(await minted.json(), 'secret')
      deniedWorkspaceId = suspendedId

      const response = await client.send('GET', `/v1/workspaces/${suspendedId}/members`, {
        bearer: openWorkspaceKey,
      })

      expect(response.status).toBe(404)
    })

    it('closes the public form routes of a suspended workspace, and keeps the CORS headers on the refusal', async () => {
      await activate(suspendedId)
      const form = await contactForm()
      deniedWorkspaceId = suspendedId

      const base = `/v1/public/workspaces/${suspendedId}/forms`
      const submit = await harness.app.request(`${base}/${form.slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://customer.example' },
        body: JSON.stringify({ answers: {} }),
      })
      const token = await harness.app.request(`${base}/${form.id}/token`)
      const embed = await harness.app.request(`${base}/${form.id}/embed`)

      expect(submit.status).toBe(403)
      expect(readRecord(readRecord(await submit.json()).error).code).toBe('entitlement_required')
      expect(submit.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(token.status).toBe(403)
      expect(embed.status).toBe(403)
    })

    it('still answers the CORS preflight of a suspended workspace form', async () => {
      await activate(suspendedId)
      const form = await contactForm()
      deniedWorkspaceId = suspendedId

      const preflight = await harness.app.request(
        `/v1/public/workspaces/${suspendedId}/forms/${form.slug}/submit`,
        {
          method: 'OPTIONS',
          headers: { Origin: 'https://customer.example', 'Access-Control-Request-Method': 'POST' },
        },
      )

      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('serves the public form of an open workspace to a visitor whose own session is in a suspended one', async () => {
      const form = await contactForm()
      await activate(suspendedId)
      deniedWorkspaceId = suspendedId

      const token = await client.send('GET', `/v1/public/workspaces/${openId}/forms/${form.id}/token`, { cookie })

      expect(token.status).toBe(200)
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

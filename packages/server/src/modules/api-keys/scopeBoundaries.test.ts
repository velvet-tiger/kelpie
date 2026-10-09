import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { API_KEY_OBJECT_DATA_RESOURCES } from '@kelpie/schemas'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resolveRestScope } from '../../lib/apiKeyScopes.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import { apiKeys } from './schema.ts'

/**
 * What a key can do with write and without delete, and with `write:objects`
 * and without `handbook:write`, on REST and on MCP, against real Postgres.
 *
 * Two tables below name the scope of every route and every tool that removes
 * something. A new one fails here until somebody decides which scope it needs.
 */

const connectionString = testDatabaseUrl(process.env)

/** Every `DELETE` route under `/v1`, and the one bulk delete that is a `POST`. */
const DELETE_ROUTE_SCOPES: Readonly<Record<string, string | null>> = {
  // Object data: the delete scope of the resource.
  'DELETE /v1/people/:id': 'people:delete',
  'DELETE /v1/companies/:id': 'companies:delete',
  'DELETE /v1/positions/:id': 'positions:delete',
  'DELETE /v1/deals/:id': 'deals:delete',
  'DELETE /v1/enquiries/:id': 'enquiries:delete',
  'DELETE /v1/opportunities/:id': 'opportunities:delete',
  'DELETE /v1/partnerships/:id': 'partnerships:delete',
  'DELETE /v1/raises/:id': 'raises:delete',
  'DELETE /v1/roles/:id': 'roles:delete',
  'DELETE /v1/candidates/:id': 'candidates:delete',
  'DELETE /v1/events/:id': 'events:delete',
  'DELETE /v1/attendances/:id': 'attendances:delete',
  'DELETE /v1/decisions/:id': 'decisions:delete',
  'DELETE /v1/plan_items/:id': 'plan_items:delete',
  'DELETE /v1/notes/:id': 'notes:delete',
  'DELETE /v1/lists/:id': 'lists:delete',
  'DELETE /v1/handbook_pages/:id': 'handbook:delete',
  'DELETE /v1/forms/:id': 'forms:delete',
  'DELETE /v1/forms/:id/submissions/:submissionId': 'forms:delete',
  'POST /v1/forms/:id/submissions/delete': 'forms:delete',
  // Ends a membership. The record and the list both stay.
  'DELETE /v1/lists/:id/members/:memberId': 'lists:write',
  // Object config and workspace admin: no delete scope, so the write scope.
  'DELETE /v1/custom_fields/:id': 'custom_fields:write',
  'DELETE /v1/pipeline_stages/:id': 'pipeline_stages:write',
  'DELETE /v1/consent_purposes/:id': 'consent_purposes:write',
  'DELETE /v1/webhooks/:id': 'webhooks:write',
  'DELETE /v1/api-keys/:id': 'api_keys:write',
  'DELETE /v1/agents/:id': 'agents:write',
  'DELETE /v1/import/jobs/:id': 'import_export:write',
  'DELETE /v1/workspaces/:id': 'workspace:write',
  'DELETE /v1/workspaces/:id/members/:memberId': 'workspace:write',
  'DELETE /v1/workspaces/:id/invites/:inviteId': 'workspace:write',
  // Session only: the service refuses every bearer credential.
  'DELETE /v1/auth/sessions/:id': null,
  'DELETE /v1/oauth/grants/:id': null,
  'DELETE /v1/oauth/connections/:id': null,
}

/** Every MCP tool that deletes, removes or revokes, and the scope it declares. */
const REMOVING_TOOL_SCOPES: Readonly<Record<string, string>> = {
  people_delete: 'people:delete',
  companies_delete: 'companies:delete',
  positions_delete: 'positions:delete',
  deals_delete: 'deals:delete',
  enquiries_delete: 'enquiries:delete',
  opportunities_delete: 'opportunities:delete',
  partnerships_delete: 'partnerships:delete',
  raises_delete: 'raises:delete',
  roles_delete: 'roles:delete',
  candidates_delete: 'candidates:delete',
  events_delete: 'events:delete',
  attendances_delete: 'attendances:delete',
  decisions_delete: 'decisions:delete',
  plan_items_delete: 'plan_items:delete',
  notes_delete: 'notes:delete',
  lists_delete: 'lists:delete',
  handbook_pages_delete: 'handbook:delete',
  forms_delete: 'forms:delete',
  form_submissions_delete: 'forms:delete',
  list_members_remove: 'lists:write',
  custom_fields_delete: 'custom_fields:write',
  pipeline_stages_delete: 'pipeline_stages:write',
  consent_purposes_delete: 'consent_purposes:write',
  webhooks_delete: 'webhooks:write',
  workspace_members_remove: 'workspace:write',
  workspace_invites_revoke: 'workspace:write',
}

describe.skipIf(connectionString === undefined)('delete and handbook scopes', () => {
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

  async function mintKey(scopes: readonly string[], bearer?: string): Promise<Response> {
    return client.send('POST', '/v1/api-keys', {
      body: { name: 'agent', kind: 'workspace', scopes },
      ...(bearer === undefined ? { cookie: acme.cookie } : { bearer }),
    })
  }

  async function key(scopes: readonly string[]): Promise<string> {
    const response = await mintKey(scopes)

    expect(response.status).toBe(201)

    return readString(await response.json(), 'secret')
  }

  async function createPerson(name = 'Ada Lovelace'): Promise<string> {
    const response = await client.send('POST', '/v1/people', { body: { name }, cookie: acme.cookie })

    return readString(await response.json(), 'id')
  }

  /** One tool call over `/mcp`: whether the tool refused, and the JSON it answered. */
  async function callTool(
    bearer: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly isError: boolean; readonly payload: Record<string, unknown> }> {
    const response = await harness.app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const result = readRecord(readRecord(await response.json()).result)
    const [content] = result.content as { text: string }[]

    return { isError: result.isError === true, payload: readRecord(JSON.parse(content?.text ?? 'null')) }
  }

  async function exists(path: string): Promise<boolean> {
    return (await client.send('GET', path, { cookie: acme.cookie })).status === 200
  }

  describe('which scope each removal needs', () => {
    it('names a scope for every DELETE route and the bulk delete, and no route is left out', () => {
      const registered = new Set(
        harness.app.routes
          .filter((route) => route.path.startsWith('/v1/'))
          .filter((route) => route.method === 'DELETE' || /\/delete$/u.test(route.path))
          .map((route) => `${route.method} ${route.path}`),
      )

      expect([...registered].sort()).toEqual(Object.keys(DELETE_ROUTE_SCOPES).sort())

      for (const [route, scope] of Object.entries(DELETE_ROUTE_SCOPES)) {
        const [method = '', path = ''] = route.split(' ')

        expect(`${route} -> ${String(resolveRestScope(method, path.replaceAll(/:[A-Za-z]+/gu, 'x')))}`).toBe(
          `${route} -> ${String(scope)}`,
        )
      }
    })

    it('names a scope for every tool that deletes, removes or revokes, and no tool is left out', () => {
      const removing = harness.contributions.mcpTools.filter(
        (tool) => /_(?:delete|remove|revoke)$/u.test(tool.name) || tool.scope.endsWith(':delete'),
      )

      expect(Object.fromEntries(removing.map((tool) => [tool.name, tool.scope]))).toEqual(REMOVING_TOOL_SCOPES)
    })

    it('gives each object-data resource a delete route or tool under its own delete scope', () => {
      const used = new Set([...Object.values(DELETE_ROUTE_SCOPES), ...Object.values(REMOVING_TOOL_SCOPES)])

      for (const resource of API_KEY_OBJECT_DATA_RESOURCES) {
        expect(used.has(`${resource}:delete`), resource).toBe(true)
      }
    })
  })

  describe('delete', () => {
    it('refuses a DELETE to a key with write and no delete, and leaves the record', async () => {
      const personId = await createPerson()

      for (const scopes of [['write:objects'], ['read:all', 'write:all'], ['people:write'], ['admin', 'write:all']]) {
        const response = await client.send('DELETE', `/v1/people/${personId}`, { bearer: await key(scopes) })

        expect(response.status).toBe(403)
        expect(readString(readRecord(await response.json()).error, 'message')).toContain('people:delete')
      }

      expect(await exists(`/v1/people/${personId}`)).toBe(true)
    })

    it('lets a key with the delete scope delete, by name or through delete:objects', async () => {
      for (const scopes of [['people:delete'], ['delete:objects'], ['write:objects', 'delete:objects']]) {
        const personId = await createPerson(`Person for ${scopes.join(' ')}`)
        const response = await client.send('DELETE', `/v1/people/${personId}`, { bearer: await key(scopes) })

        expect(response.status).toBe(204)
        expect(await exists(`/v1/people/${personId}`)).toBe(false)
      }
    })

    it('lets a full-access key delete, as it has every scope', async () => {
      const personId = await createPerson()
      const created = await client.send('POST', '/v1/api-keys', {
        body: { name: 'full', kind: 'workspace', full_access: true },
        cookie: acme.cookie,
      })
      const response = await client.send('DELETE', `/v1/people/${personId}`, {
        bearer: readString(await created.json(), 'secret'),
      })

      expect(response.status).toBe(204)
    })

    it('gives a delete scope neither read nor write', async () => {
      const personId = await createPerson()
      const deleter = await key(['delete:objects'])

      expect((await client.send('GET', `/v1/people/${personId}`, { bearer: deleter })).status).toBe(403)
      expect((await client.send('GET', '/v1/people', { bearer: deleter })).status).toBe(403)
      expect(
        (await client.send('PATCH', `/v1/people/${personId}`, { body: { name: 'Renamed' }, bearer: deleter })).status,
      ).toBe(403)
      expect((await client.send('POST', '/v1/people', { body: { name: 'New' }, bearer: deleter })).status).toBe(403)
    })

    it('does not let the delete scope of one resource delete another', async () => {
      const personId = await createPerson()

      expect(
        (await client.send('DELETE', `/v1/people/${personId}`, { bearer: await key(['companies:delete']) })).status,
      ).toBe(403)
    })

    it('refuses the delete tool over MCP to a key with write only, and allows it with delete', async () => {
      const personId = await createPerson()
      const refused = await callTool(await key(['read:objects', 'write:objects']), 'people_delete', { id: personId })

      expect(refused.isError).toBe(true)
      expect(readRecord(refused.payload.error)).toMatchObject({ code: 'forbidden' })
      expect(readString(readRecord(refused.payload.error), 'message')).toContain('people:delete')
      expect(await exists(`/v1/people/${personId}`)).toBe(true)

      const allowed = await callTool(await key(['people:delete']), 'people_delete', { id: personId })

      expect(allowed.isError).toBe(false)
      expect(allowed.payload).toEqual({ id: personId, deleted: true })
      expect(await exists(`/v1/people/${personId}`)).toBe(false)
    })

    it('keeps taking a record off a list under lists:write, and puts deleting the list under lists:delete', async () => {
      const personId = await createPerson()
      const list = readRecord(
        await (
          await client.send('POST', '/v1/lists', {
            body: { name: 'Prospects', target_type: 'person' },
            cookie: acme.cookie,
          })
        ).json(),
      )
      const listId = readString(list, 'id')
      const member = readRecord(
        await (
          await client.send('POST', `/v1/lists/${listId}/members`, {
            body: { target_type: 'person', target_id: personId },
            cookie: acme.cookie,
          })
        ).json(),
      )
      const writer = await key(['lists:write'])

      expect((await client.send('DELETE', `/v1/lists/${listId}`, { bearer: writer })).status).toBe(403)
      expect(
        (await client.send('DELETE', `/v1/lists/${listId}/members/${readString(member, 'id')}`, { bearer: writer }))
          .status,
      ).toBe(204)
      // The membership went. The person and the list did not.
      expect(await exists(`/v1/people/${personId}`)).toBe(true)
      expect(await exists(`/v1/lists/${listId}`)).toBe(true)
      expect((await client.send('DELETE', `/v1/lists/${listId}`, { bearer: await key(['lists:delete']) })).status).toBe(
        204,
      )
    })

    it('puts both ways of deleting form submissions under forms:delete, on REST and on MCP', async () => {
      const writer = await key(['forms:write'])
      const deleter = await key(['forms:delete'])

      // The scope is checked before the form is looked up, so the ids need not exist.
      for (const [method, path, body] of [
        ['DELETE', '/v1/forms/frm_none/submissions/fsub_none', undefined],
        ['POST', '/v1/forms/frm_none/submissions/delete', { ids: ['fsub_none'] }],
        ['DELETE', '/v1/forms/frm_none', undefined],
      ] as const) {
        expect((await client.send(method, path, { body, bearer: writer })).status, path).toBe(403)
        expect((await client.send(method, path, { body, bearer: deleter })).status, path).toBe(404)
      }

      const args = { form_id: 'frm_none', submission_ids: ['fsub_none'] }

      expect(readRecord((await callTool(writer, 'form_submissions_delete', args)).payload.error).code).toBe('forbidden')
      expect(readRecord((await callTool(deleter, 'form_submissions_delete', args)).payload.error).code).toBe('not_found')
    })

    it('keeps the deletes of admin and config resources under their write scope', async () => {
      const admin = await key(['admin'])

      // 404 and not 403: the scope allowed the call, and nothing has that id.
      expect((await client.send('DELETE', '/v1/webhooks/whk_none', { bearer: admin })).status).toBe(404)
      expect((await client.send('DELETE', '/v1/custom_fields/cf_none', { bearer: admin })).status).toBe(404)
      expect((await client.send('DELETE', '/v1/api-keys/apik_none', { bearer: admin })).status).toBe(404)
      expect((await client.send('DELETE', '/v1/webhooks/whk_none', { bearer: await key(['delete:objects']) })).status).toBe(
        403,
      )
    })
  })

  describe('the handbook', () => {
    const page = { title: 'Pricing', body: 'We charge by the seat.' }

    it('refuses a handbook write to write:objects, on REST and on MCP, and still lets it read', async () => {
      const writer = await key(['read:objects', 'write:objects'])
      const overRest = await client.send('POST', '/v1/handbook_pages', { body: page, bearer: writer })
      const overMcp = await callTool(writer, 'handbook_pages_create', page)

      expect(overRest.status).toBe(403)
      expect(readString(readRecord(await overRest.json()).error, 'message')).toContain('handbook:write')
      expect(overMcp.isError).toBe(true)
      expect(readString(readRecord(overMcp.payload.error), 'message')).toContain('handbook:write')
      expect((await client.send('GET', '/v1/handbook_pages', { bearer: writer })).status).toBe(200)
      // The rest of what write:objects gives is as it was.
      expect((await client.send('POST', '/v1/people', { body: { name: 'New' }, bearer: writer })).status).toBe(201)
    })

    it('refuses a change to an existing page, and the seed, to write:objects', async () => {
      const writer = await key(['write:objects'])
      const [existing] = readList(await (await client.send('GET', '/v1/handbook_pages', { cookie: acme.cookie })).json())
      const pageId = readString(existing, 'id')

      expect(
        (await client.send('PATCH', `/v1/handbook_pages/${pageId}`, { body: { body: 'Rewritten' }, bearer: writer }))
          .status,
      ).toBe(403)
      expect((await client.send('DELETE', `/v1/handbook_pages/${pageId}`, { bearer: writer })).status).toBe(403)
      expect(
        (
          await client.send('POST', `/v1/workspaces/${acme.workspaceId}/handbook/seed`, {
            body: { handbook_template: 'startup' },
            bearer: writer,
          })
        ).status,
      ).toBe(403)
    })

    it('lets handbook:write and write:all write a page, on REST and on MCP', async () => {
      for (const scopes of [['handbook:write'], ['write:all'], ['write:objects', 'handbook:write']]) {
        const writer = await key(scopes)
        const overRest = await client.send('POST', '/v1/handbook_pages', {
          body: { ...page, title: `REST ${scopes.join(' ')}` },
          bearer: writer,
        })
        const overMcp = await callTool(writer, 'handbook_pages_create', { ...page, title: `MCP ${scopes.join(' ')}` })

        expect(overRest.status).toBe(201)
        expect(overMcp.isError).toBe(false)
      }
    })

    it('does not let handbook:write delete a page; that needs handbook:delete', async () => {
      const created = await client.send('POST', '/v1/handbook_pages', { body: page, cookie: acme.cookie })
      const pageId = readString(await created.json(), 'id')

      expect(
        (await client.send('DELETE', `/v1/handbook_pages/${pageId}`, { bearer: await key(['handbook:write']) })).status,
      ).toBe(403)
      expect(
        (await client.send('DELETE', `/v1/handbook_pages/${pageId}`, { bearer: await key(['handbook:delete']) })).status,
      ).toBe(204)
    })
  })

  describe('creating a key from a key', () => {
    it('does not let a key give a delete scope, or handbook:write, that it does not hold', async () => {
      const minter = await key(['api_keys:write', 'write:objects'])

      for (const scopes of [['people:delete'], ['delete:objects'], ['handbook:write'], ['write:objects', 'handbook:delete']]) {
        expect((await mintKey(scopes, minter)).status, scopes.join(' ')).toBe(403)
      }

      expect((await mintKey(['write:objects'], minter)).status).toBe(201)
    })

    it('lets a key give the delete scopes it holds', async () => {
      const minter = await key(['api_keys:write', 'delete:objects', 'handbook:write'])

      expect((await mintKey(['people:delete', 'handbook:delete', 'handbook:write'], minter)).status).toBe(201)
      expect((await mintKey(['delete:objects'], minter)).status).toBe(201)
      // Delete implies neither write nor read, so it cannot give them.
      expect((await mintKey(['people:write'], minter)).status).toBe(403)
      expect((await mintKey(['people:read'], minter)).status).toBe(403)
    })
  })

  describe('a key from before the scopes changed', () => {
    /**
     * Gives the one key of the test the scopes it had under the old meaning,
     * then runs the migration as it is on disk. The migration changes rows
     * only, so it is safe to run on the migrated test database.
     */
    async function migrateStoredScopes(before: readonly string[]): Promise<void> {
      const migration = readFileSync(join(coreMigrationsDirectory, '0065_delete_and_handbook_scopes.sql'), 'utf8')

      await database.db.update(apiKeys).set({ scopes: [...before] })
      await database.db.execute(sql.raw(migration.replaceAll('--> statement-breakpoint', '')))
    }

    it('keeps deleting and writing the handbook with write:objects', async () => {
      const personId = await createPerson()
      const old = await key(['read:objects'])

      await migrateStoredScopes(['read:objects', 'write:objects'])

      expect((await client.send('DELETE', `/v1/people/${personId}`, { bearer: old })).status).toBe(204)
      expect(
        (await client.send('POST', '/v1/handbook_pages', { body: { title: 'Kept', body: 'Text' }, bearer: old })).status,
      ).toBe(201)
      expect((await callTool(old, 'handbook_pages_create', { title: 'Kept over MCP', body: 'Text' })).isError).toBe(false)
    })

    it('keeps deleting with a per-resource write scope, for that resource only', async () => {
      const personId = await createPerson()
      const old = await key(['read:objects'])

      await migrateStoredScopes(['people:write', 'companies:read'])

      expect((await client.send('DELETE', '/v1/companies/com_none', { bearer: old })).status).toBe(403)
      expect((await client.send('DELETE', `/v1/people/${personId}`, { bearer: old })).status).toBe(204)
      expect(
        (await client.send('POST', '/v1/handbook_pages', { body: { title: 'No', body: 'Text' }, bearer: old })).status,
      ).toBe(403)
    })
  })
})

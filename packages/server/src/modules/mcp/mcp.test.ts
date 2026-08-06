import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import { LATEST_PROTOCOL_VERSION } from './protocol.ts'

/**
 * `/mcp` against real Postgres: the transport, and enough of the tool surface to
 * prove a tool is the REST endpoint by another door.
 *
 * Per-resource behaviour is not re-tested here. A tool and its route share the
 * schema, the mapper and the service, so a suite that asserted both would be
 * asserting the same code twice.
 */

const connectionString = testDatabaseUrl(process.env)

interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

describe.skipIf(connectionString === undefined)('mcp', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner
  let workspaceKey: string

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
  })

  afterAll(async () => {
    await database.close()
  })

  async function mintKey(cookie: string): Promise<string> {
    const response = await client.send('POST', '/v1/api-keys', {
      body: { name: 'agent', kind: 'workspace' },
      cookie,
    })

    if (response.status !== 201) {
      throw new Error(`Minting a key answered ${String(response.status)}: ${await response.text()}`)
    }

    return readString(await response.json(), 'secret')
  }

  beforeEach(async () => {
    await database.truncateAll()
    harness = await createTestApp({
      modules: coreModules,
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    client = createTestClient(harness.app)
    acme = await client.owner()
    workspaceKey = await mintKey(acme.cookie)
  })

  /**
   * One JSON-RPC request over the transport, as an MCP client would send it.
   *
   * `null` means send no credential. An explicit `undefined` would take the
   * default parameter, which is the workspace key.
   */
  function post(body: unknown, bearer: string | null = workspaceKey): Promise<Response> {
    return Promise.resolve(
      harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
      }),
    )
  }

  function request(id: number, method: string, params?: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
  }

  async function envelope(response: Response): Promise<JsonRpcEnvelope> {
    return (await response.json()) as JsonRpcEnvelope
  }

  /** The parsed payload of a `tools/call` that succeeded. */
  async function callTool(name: string, args: unknown, bearer = workspaceKey): Promise<unknown> {
    const body = await envelope(await post(request(1, 'tools/call', { name, arguments: args }), bearer))
    const result = readRecord(body.result)

    expect(result.isError, JSON.stringify(result)).toBe(false)

    const content = result.content as { text: string }[]

    return JSON.parse(content[0]?.text ?? 'null')
  }

  /** The `api.md` error body a failing tool reports instead of a JSON-RPC error. */
  async function callToolError(name: string, args: unknown, bearer = workspaceKey): Promise<Record<string, unknown>> {
    const body = await envelope(await post(request(1, 'tools/call', { name, arguments: args }), bearer))
    const result = readRecord(body.result)

    expect(result.isError, JSON.stringify(result)).toBe(true)

    const content = result.content as { text: string }[]

    return readRecord(JSON.parse(content[0]?.text ?? 'null')).error as Record<string, unknown>
  }

  describe('transport', () => {
    it('initializes, echoing a protocol version it speaks', async () => {
      const response = await post(
        request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {} }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/json')

      const result = readRecord((await envelope(response)).result)

      expect(result.protocolVersion).toBe('2025-03-26')
      expect(result.capabilities).toEqual({ tools: { listChanged: false } })
      expect(readRecord(result.serverInfo).name).toBe('kelpie')
      expect(String(result.instructions)).toContain('snake_case')
    })

    it('answers an unknown protocol version with the newest it speaks', async () => {
      const response = await post(request(1, 'initialize', { protocolVersion: '2019-01-01' }))

      expect(readRecord((await envelope(response)).result).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    })

    it('refuses a protocol version header it does not speak', async () => {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '1999-12-31',
          Authorization: `Bearer ${workspaceKey}`,
        },
        body: JSON.stringify(request(1, 'ping')),
      })

      expect(response.status).toBe(400)
      expect(readRecord(readRecord(await response.json()).error).code).toBe('bad_request')
    })

    it('answers a notification with 202 and no body', async () => {
      const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

      expect(response.status).toBe(202)
      expect(await response.text()).toBe('')
    })

    it('answers a 2025-03-26 batch with an array', async () => {
      const response = await post([request(1, 'ping'), request(2, 'ping')])
      const payload = (await response.json()) as JsonRpcEnvelope[]

      expect(payload.map((message) => message.id)).toEqual([1, 2])
    })

    it('sends an event stream to a client that will take nothing else', async () => {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${workspaceKey}`,
        },
        body: JSON.stringify(request(1, 'ping')),
      })

      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
      expect(await response.text()).toBe(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`)
    })

    it('refuses GET and DELETE with 405', async () => {
      for (const method of ['GET', 'DELETE']) {
        const response = await harness.app.request('/mcp', {
          method,
          headers: { Authorization: `Bearer ${workspaceKey}` },
        })

        expect(response.status, method).toBe(405)
      }
    })

    it('reports an unknown method as method not found', async () => {
      const body = await envelope(await post(request(1, 'resources/list')))

      expect(body.error?.code).toBe(-32_601)
    })

    it('reports an unreadable message as a parse error', async () => {
      const body = await envelope(await post({ jsonrpc: '1.0', method: 'ping' }))

      expect(body.error?.code).toBe(-32_700)
      expect(body.id).toBeNull()
    })
  })

  describe('authentication', () => {
    it('refuses a request with no key', async () => {
      const response = await post(request(1, 'tools/list'), null)

      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(readRecord(readRecord(await response.json()).error).code).toBe('unauthorized')
    })

    it('refuses a key that is not one this workspace issued', async () => {
      const response = await post(request(1, 'tools/list'), 'kp_live_nonsense')

      expect(response.status).toBe(401)
    })

    /**
     * A session cookie works on every REST endpoint and deliberately does not
     * work here. Refusing ambient credentials is what makes the endpoint's
     * missing CORS configuration a complete answer to a cross-origin caller.
     */
    it('refuses a browser session cookie', async () => {
      const response = await harness.app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: acme.cookie },
        body: JSON.stringify(request(1, 'tools/list')),
      })

      expect(response.status).toBe(401)
    })
  })

  describe('tools/list', () => {
    it('publishes every resource with a JSON Schema a client can read', async () => {
      const result = readRecord((await envelope(await post(request(1, 'tools/list')))).result)
      const tools = result.tools as { name: string; description: string; inputSchema: Record<string, unknown> }[]
      const names = tools.map((tool) => tool.name)

      expect(names).toContain('people_list')
      expect(names).toContain('people_create')
      expect(names).toContain('handbook_pages_list')
      expect(names).toContain('forms_list')
      expect(names).toContain('export_csv')
      expect(names).toContain('import_preview')

      const create = tools.find((tool) => tool.name === 'people_create')

      expect(create?.description).toContain('POST /v1/people')
      expect(create?.inputSchema.type).toBe('object')
      // `name` is the only field without a default, so it is the only required one.
      expect(create?.inputSchema.required).toEqual(['name'])
    })

    it('names every tool once', async () => {
      const result = readRecord((await envelope(await post(request(1, 'tools/list')))).result)
      const names = (result.tools as { name: string }[]).map((tool) => tool.name)

      expect(names).toEqual([...new Set(names)])
    })
  })

  describe('GET /v1/mcp/tools', () => {
    it('answers a signed-in reader with the same listing tools/list publishes', async () => {
      const response = await client.send('GET', '/v1/mcp/tools', { cookie: acme.cookie })

      expect(response.status).toBe(200)

      const catalog = readList(await response.json())
      const overMcp = readRecord((await envelope(await post(request(1, 'tools/list')))).result)

      expect(catalog.map((tool) => tool.name)).toEqual(
        (overMcp.tools as { name: string }[]).map((tool) => tool.name),
      )
      expect(readRecord(catalog[0] ?? {}).input_schema).toBeDefined()
    })

    it('refuses a caller with no credentials', async () => {
      expect((await client.send('GET', '/v1/mcp/tools')).status).toBe(401)
    })
  })

  describe('tools/call', () => {
    it('creates, reads, updates, lists and deletes a record', async () => {
      const created = readRecord(await callTool('people_create', { name: 'Ada Lovelace', summary: 'Maths' }))
      const id = readString(created, 'id')

      expect(created.name).toBe('Ada Lovelace')
      expect(created.tags).toEqual([])

      expect(readRecord(await callTool('people_get', { id })).summary).toBe('Maths')

      const updated = readRecord(await callTool('people_update', { id, relationship: 'warm' }))

      expect(updated.relationship).toBe('warm')
      expect(updated.name).toBe('Ada Lovelace')

      const page = readRecord(await callTool('people_list', { q: 'Lovelace' }))

      expect((page.data as Record<string, unknown>[]).map((person) => person.id)).toEqual([id])
      expect(page.next_cursor).toBeNull()

      expect(await callTool('people_delete', { id })).toEqual({ id, deleted: true })
      expect((await callToolError('people_get', { id })).code).toBe('not_found')
    })

    it('reads the same record the REST surface wrote', async () => {
      const posted = await client.send('POST', '/v1/companies', {
        body: { name: 'Acme Corp', stage: 'startup' },
        cookie: acme.cookie,
      })
      const id = readString(await posted.json(), 'id')

      expect(readRecord(await callTool('companies_get', { id })).name).toBe('Acme Corp')
    })

    it('pages a list with the cursor it was handed', async () => {
      for (const name of ['One', 'Two', 'Three']) {
        await callTool('people_create', { name })
      }

      const first = readRecord(await callTool('people_list', { limit: 2 }))

      expect((first.data as unknown[]).length).toBe(2)

      const second = readRecord(await callTool('people_list', { limit: 2, cursor: first.next_cursor }))

      expect((second.data as unknown[]).length).toBe(1)
      expect(second.next_cursor).toBeNull()
    })

    it('reports a validation failure as the 422 the REST body would have produced', async () => {
      const error = await callToolError('people_create', { name: '', nickname: 'Ada' })

      expect(error.code).toBe('validation_failed')
      expect(error.details).toEqual(
        expect.arrayContaining([{ field: 'nickname', message: 'Unknown field' }]),
      )
    })

    it('refuses an unknown tool as a protocol error, not a tool result', async () => {
      const body = await envelope(await post(request(1, 'tools/call', { name: 'people_enrich', arguments: {} })))

      expect(body.error?.code).toBe(-32_602)
      expect(String(body.error?.message)).toContain('people_enrich')
    })

    it('cannot see another workspace', async () => {
      const created = readRecord(await callTool('people_create', { name: 'Ada Lovelace' }))
      const other = await client.owner('grace@example.com', 'globex')
      const otherKey = await mintKey(other.cookie)

      const error = await callToolError('people_get', { id: readString(created, 'id') }, otherKey)

      expect(error.code).toBe('not_found')
    })
  })
})

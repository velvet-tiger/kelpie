import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { runMigrations } from '../../runtime/migrate.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreModules } from '../core.ts'
import type { AiRunSettledData } from './events.ts'
import { createAiModule } from './index.ts'
import type { AiCompletionRequest, AiCompletionResult, AiProviderPort } from './provider.ts'
import { AI_RUNS_LIMIT } from './rules.ts'
import { aiRuns } from './schema.ts'

/**
 * Person intake against the real test database and the real CRUD tools:
 * identify and research as metered synchronous runs, the CRM lookups that
 * feed them, web search on and off, and `apply` writing through the same
 * tools a direct API call uses. The model is a queue of canned replies.
 */

// The same scope as `ai.test.ts`: the module's own tables live there.
const connectionString = testDatabaseUrl(process.env, 'ai')

interface ProviderFake extends AiProviderPort {
  readonly requests: AiCompletionRequest[]
  queue(result: AiCompletionResult): void
  reset(): void
}

function makeProviderFake(): ProviderFake {
  const replies: AiCompletionResult[] = []
  const requests: AiCompletionRequest[] = []

  return {
    requests,
    complete(request) {
      requests.push(request)
      const reply = replies.shift()
      if (reply === undefined) {
        return Promise.reject(new Error('The provider fake ran out of replies'))
      }
      return Promise.resolve(reply)
    },
    queue(result) {
      replies.push(result)
    },
    reset() {
      replies.length = 0
      requests.length = 0
    },
  }
}

function reply(
  body: unknown,
  webSources: readonly { url: string; title: string }[] = [],
): AiCompletionResult {
  return {
    stopReason: 'end_turn',
    text: typeof body === 'string' ? body : JSON.stringify(body),
    usage: { inputTokens: 100, outputTokens: 50 },
    webSources,
  }
}

interface Harness {
  readonly app: TestApp
  readonly client: TestClient
  readonly provider: ProviderFake
  limit: number | undefined
}

async function buildHarness(database: TestDatabase): Promise<Harness> {
  const provider = makeProviderFake()
  const entitlements = createEntitlementRegistry()
  const state: { limit: number | undefined } = { limit: undefined }

  entitlements.provide((_workspaceId, capability) =>
    Promise.resolve(
      capability.name === AI_RUNS_LIMIT.name && state.limit !== undefined
        ? { kind: 'limit' as const, limit: state.limit }
        : undefined,
    ),
  )

  const build = (): AiProviderPort => provider
  const app = await createTestApp({
    modules: [...coreModules, createAiModule({ keyMode: 'workspace', providers: { openai: build, anthropic: build } })],
    environment: TEST_ENVIRONMENT,
    services: createTestServices({ db: database.db }),
    entitlements,
  })

  await runMigrations(
    database.db,
    app.contributions.schemas,
    createLogger({ level: 'error', transports: [createCaptureTransport(() => undefined)] }),
  )

  return {
    app,
    client: createTestClient(app.app, app.services.db),
    provider,
    get limit() {
      return state.limit
    },
    set limit(value) {
      state.limit = value
    },
  }
}

async function enabledOwner(h: Harness, email: string): Promise<{ readonly cookie: string; readonly workspaceId: string }> {
  const owner = await h.client.owner(email)
  await h.app.services.events.drain()

  const response = await h.client.send('POST', '/v1/ai/settings', {
    cookie: owner.cookie,
    body: { provider: 'anthropic', api_key: 'sk-ant-intake-test-0001' },
  })
  if (response.status !== 200) {
    throw new Error(`Enabling ai answered ${String(response.status)}: ${await response.text()}`)
  }

  return owner
}

const IDENTIFY_REPLY = {
  candidates: [
    {
      name: 'Dana Reyes',
      headline: 'CTO at Brightline Health',
      company_name: 'Brightline Health',
      title: 'CTO',
      location: 'Austin, TX',
      email: 'dana@brightline.health',
      profile_urls: ['linkedin.com/in/danareyes', 'not a url'],
      evidence: 'The email domain matches Brightline Health.',
      confidence: 'high',
    },
  ],
  question: null,
  sources: [
    { url: 'https://brightline.health/team', title: 'Team' },
    { url: 'https://invented.example/dana', title: 'Made up' },
  ],
}

const SEARCHED = [{ url: 'https://www.brightline.health/team/', title: 'Brightline team' }]

const CANDIDATE = {
  key: 'c1',
  name: 'Dana Reyes',
  headline: 'CTO at Brightline Health',
  company_name: 'Brightline Health',
  title: 'CTO',
  location: 'Austin, TX',
  email: 'dana@brightline.health',
  profile_urls: ['https://linkedin.com/in/danareyes'],
  evidence: 'The email domain matches Brightline Health.',
  confidence: 'high',
  existing_people: [],
}

function researchReply(existingCompanyId: string | null): Record<string, unknown> {
  return {
    summary: 'Dana Reyes is CTO of Brightline Health.',
    person: {
      name: 'Dana Reyes',
      first_name: 'Dana',
      last_name: 'Reyes',
      email: 'dana@brightline.health',
      social_profiles: [
        { network: 'linkedin', url: 'https://linkedin.com/in/danareyes' },
        { network: 'myspace', url: 'https://myspace.com/dana' },
      ],
      summary: 'CTO at Brightline Health; met at HLTH.',
      tags: ['hlth-2026'],
      relationship: 'lukewarm',
    },
    companies: [
      { ref: 'c1', existing_id: existingCompanyId, name: 'Brightline Health', domain: 'brightline.health', stage: 'growth' },
      { ref: 'c2', existing_id: 'com_invented', name: 'Old Employer' },
    ],
    positions: [
      { company_ref: 'c1', title: 'CTO' },
      { company_ref: 'nowhere', title: 'Ghost' },
    ],
    note: 'Leads a 40-person engineering team.',
    deals: [{ company_ref: 'c1', name: 'Brightline pilot', reason: 'Asked for pricing at HLTH.' }],
    partnerships: [],
    enquiries: [],
    sources: [{ url: 'https://brightline.health/team', title: 'Team' }],
  }
}

async function runRows(h: Harness, workspaceId: string): Promise<(typeof aiRuns.$inferSelect)[]> {
  return h.app.services.db.select().from(aiRuns).where(eq(aiRuns.workspaceId, workspaceId))
}

describe.skipIf(connectionString === undefined)('ai person intake', () => {
  let database: TestDatabase
  let h: Harness
  const settledEvents: AiRunSettledData[] = []

  beforeAll(async () => {
    if (connectionString === undefined) {
      throw new Error('unreachable: the suite is skipped without a connection string')
    }

    database = await connectTestDatabase(connectionString)
    h = await buildHarness(database)
    h.app.services.events.subscribe('ai.run.settled', (event) => {
      settledEvents.push(event.data)
    })
  })

  afterAll(async () => {
    await database.close()
  })

  beforeEach(async () => {
    await database.truncateAll()
    settledEvents.length = 0
    h.provider.reset()
    h.limit = undefined
  })

  describe('identify', () => {
    it('refuses while AI is not enabled, and records no run', async () => {
      const owner = await h.client.owner('off@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes' },
      })

      expect(response.status).toBe(409)
      expect(h.provider.requests).toHaveLength(0)
      expect(await runRows(h, owner.workspaceId)).toHaveLength(0)
    })

    it('refuses empty notes', async () => {
      const owner = await enabledOwner(h, 'empty@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: '   ' },
      })

      expect(response.status).toBe(422)
    })

    it('searches the web, keys the candidates, finds existing people and keeps only searched sources', async () => {
      const owner = await enabledOwner(h, 'identify@example.com')
      const existing = await h.client.send('POST', '/v1/people', {
        cookie: owner.cookie,
        body: { name: 'Dana Reyes', email: 'dana@brightline.health' },
      })
      const existingId = readString(readRecord(await existing.json()), 'id')

      h.provider.queue(reply(IDENTIFY_REPLY, SEARCHED))
      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes, dana@brightline.health, met at HLTH' },
      })

      expect(response.status).toBe(200)
      const body = readRecord(await response.json())
      const [candidate] = body.candidates as Record<string, unknown>[]

      expect(h.provider.requests[0]?.webSearch).toEqual({ maxUses: 4 })
      // LinkedIn cannot be opened; the model is told to read search snippets instead.
      expect(h.provider.requests[0]?.instructions).toContain('LinkedIn pages cannot be opened')
      expect(h.provider.requests[0]?.messages[0]?.text).toContain('dana@brightline.health')
      expect(candidate).toMatchObject({
        key: 'c1',
        name: 'Dana Reyes',
        profile_urls: ['https://linkedin.com/in/danareyes'],
        existing_people: [{ id: existingId, name: 'Dana Reyes', email: 'dana@brightline.health' }],
      })
      expect(body.sources).toEqual([{ url: 'https://brightline.health/team', title: 'Team' }])
      expect(body.question).toBeNull()

      const [run] = await runRows(h, owner.workspaceId)
      expect(run).toMatchObject({
        id: body.run_id,
        agentRunId: body.run_id,
        taskId: 'person_intake.identify',
        targetType: 'workspace',
        targetId: owner.workspaceId,
        status: 'succeeded',
        inputTokens: 100,
        outputTokens: 50,
        // The pasted notes are personal data; a settled run keeps none of them.
        prompt: null,
        context: null,
      })
    })

    it('does not search when the workspace switched web search off', async () => {
      const owner = await enabledOwner(h, 'nosearch@example.com')
      const saved = await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie, body: { web_search: false } })
      expect(readRecord(await saved.json()).web_search).toBe(false)

      h.provider.queue(reply(IDENTIFY_REPLY, SEARCHED))
      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes, see https://brightline.health/team' },
      })
      const body = readRecord(await response.json())

      expect(h.provider.requests[0]?.webSearch).toBeUndefined()
      expect(h.provider.requests[0]?.instructions).toContain('Web search is off')
      expect(h.provider.requests[0]?.instructions).not.toContain('LinkedIn pages cannot be opened')
      // With no search, a URL counts only when the user pasted it.
      expect(body.sources).toEqual([{ url: 'https://brightline.health/team', title: 'Team' }])
    })

    it('asks for more detail when the model cannot tell who it is', async () => {
      const owner = await enabledOwner(h, 'question@example.com')
      h.provider.queue(reply({ candidates: [], question: 'Which company does Sam work at?', sources: [] }))

      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Sam' },
      })
      const body = readRecord(await response.json())

      expect(body.candidates).toEqual([])
      expect(body.question).toBe('Which company does Sam work at?')
    })

    it('records the requests and searches a run spent, and reports it settled once', async () => {
      const owner = await enabledOwner(h, 'counts@example.com')
      h.provider.queue({ ...reply(IDENTIFY_REPLY, SEARCHED), usage: { inputTokens: 100, outputTokens: 50, requests: 3, webSearches: 4 } })

      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes, dana@brightline.health' },
      })
      expect(response.status).toBe(200)

      const [run] = await runRows(h, owner.workspaceId)
      expect(run).toMatchObject({ modelRequests: 3, webSearches: 4 })

      await h.app.services.events.drain()
      expect(settledEvents).toEqual([
        expect.objectContaining({
          runId: run?.id,
          agentRunId: null,
          taskId: 'person_intake.identify',
          status: 'succeeded',
          inputTokens: 100,
          outputTokens: 50,
          modelRequests: 3,
          webSearches: 4,
        }),
      ])
      // Counts only: the notes never reach a subscriber.
      expect(JSON.stringify(settledEvents)).not.toContain('Dana')
    })

    it('repairs an invalid reply once, and fails the run after a second', async () => {
      const owner = await enabledOwner(h, 'repair@example.com')
      h.provider.queue(reply('not json at all'))
      h.provider.queue(reply(IDENTIFY_REPLY, SEARCHED))

      const repaired = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes' },
      })
      expect(repaired.status).toBe(200)
      expect(h.provider.requests).toHaveLength(2)
      expect(h.provider.requests[1]?.webSearch).toBeUndefined()
      expect(h.provider.requests[1]?.messages[2]?.text).toContain('did not match the required JSON shape')

      h.provider.queue(reply('still not json'))
      h.provider.queue(reply({ candidates: 'nope' }))
      const failed = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes' },
      })
      expect(failed.status).toBe(409)

      const rows = await runRows(h, owner.workspaceId)
      expect(rows.map((row) => row.status).sort()).toEqual(['failed', 'succeeded'])
      expect(rows.find((row) => row.status === 'failed')?.inputTokens).toBe(200)
      // A port that does not report requests counts one for each call.
      expect(rows.find((row) => row.status === 'failed')?.modelRequests).toBe(2)
    })

    it('shows a provider failure on a workspace key and settles the run failed', async () => {
      const owner = await enabledOwner(h, 'provider@example.com')
      h.provider.queue({
        stopReason: 'failed',
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: { code: 'invalid_api_key', message: 'The Anthropic API key was rejected.' },
      })

      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes' },
      })

      expect(response.status).toBe(500)
      expect(readString(readRecord(await response.json()).error, 'message')).toBe('The Anthropic API key was rejected.')
      const [run] = await runRows(h, owner.workspaceId)
      expect(run?.status).toBe('failed')
    })

    it('counts against the monthly AI run limit', async () => {
      const owner = await enabledOwner(h, 'limit@example.com')
      h.limit = 0

      const response = await h.client.send('POST', '/v1/ai/person-intake/identify', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes' },
      })

      expect(response.status).toBe(403)
      expect(h.provider.requests).toHaveLength(0)
    })
  })

  describe('research', () => {
    it('offers matching companies, links an offered id, and creates for an invented one', async () => {
      const owner = await enabledOwner(h, 'research@example.com')
      const company = await h.client.send('POST', '/v1/companies', {
        cookie: owner.cookie,
        body: { name: 'Brightline Health', domain: 'brightline.health' },
      })
      const companyId = readString(readRecord(await company.json()), 'id')

      h.provider.queue(reply(researchReply(companyId), SEARCHED))
      const response = await h.client.send('POST', '/v1/ai/person-intake/research', {
        cookie: owner.cookie,
        body: { text: 'Dana Reyes, dana@brightline.health', candidate: CANDIDATE },
      })

      expect(response.status).toBe(200)
      const body = readRecord(await response.json())
      const request = h.provider.requests[0]

      expect(request?.webSearch).toEqual({ maxUses: 8 })
      expect(request?.messages[0]?.text).toContain(`Brightline Health (id ${companyId}, brightline.health)`)

      const items = body.items as Record<string, unknown>[]
      expect(items.map((item) => item.key)).toEqual(['person', 'co1', 'co2', 'pos1', 'note', 'de1'])
      expect(items[0]).toMatchObject({
        kind: 'person',
        action: 'create',
        existing_id: null,
        fields: {
          name: 'Dana Reyes',
          social_profiles: [{ network: 'linkedin', url: 'https://linkedin.com/in/danareyes' }],
        },
      })
      // A misspelt enum is dropped, not fatal.
      expect(items[0]?.fields).not.toHaveProperty('relationship')
      expect(items[1]).toMatchObject({ kind: 'company', action: 'existing', existing_id: companyId })
      expect(items[2]).toMatchObject({ kind: 'company', action: 'create', existing_id: null })
      expect(items[3]).toMatchObject({ kind: 'position', company_key: 'co1', title: 'CTO' })
      expect(items[4]?.body).toContain('Leads a 40-person engineering team.')
      expect(items[4]?.body).toContain('[Team](https://brightline.health/team)')
      expect(items[5]).toMatchObject({ kind: 'deal', company_key: 'co1', reason: 'Asked for pricing at HLTH.' })

      const [run] = await runRows(h, owner.workspaceId)
      expect(run).toMatchObject({ taskId: 'person_intake.research', status: 'succeeded' })
    })

    it('answers 404 for an unknown existing person and spends no run', async () => {
      const owner = await enabledOwner(h, 'missing@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/research', {
        cookie: owner.cookie,
        body: { text: 'Dana', candidate: CANDIDATE, existing_person_id: 'per_missing' },
      })

      expect(response.status).toBe(404)
      expect(await runRows(h, owner.workspaceId)).toHaveLength(0)
    })
  })

  describe('apply', () => {
    it('writes the ticked items in order, as the caller, and links them', async () => {
      const owner = await enabledOwner(h, 'apply@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        cookie: owner.cookie,
        body: {
          items: [
            { key: 'de1', kind: 'deal', company_key: 'co1', fields: { name: 'Brightline pilot' }, reason: 'Pricing' },
            { key: 'note', kind: 'note', body: 'Research note body' },
            { key: 'pos1', kind: 'position', company_key: 'co1', title: 'CTO' },
            {
              key: 'person',
              kind: 'person',
              action: 'create',
              existing_id: null,
              fields: { name: 'Dana Reyes', email: 'dana@brightline.health', tags: ['hlth-2026'] },
            },
            {
              key: 'co1',
              kind: 'company',
              action: 'create',
              existing_id: null,
              fields: { name: 'Brightline Health', domain: 'brightline.health' },
            },
          ],
        },
      })

      expect(response.status).toBe(200)
      const results = (readRecord(await response.json()).results as Record<string, unknown>[])
      expect(results.map((result) => [result.key, result.status])).toEqual([
        ['co1', 'created'],
        ['person', 'created'],
        // The email-domain linker linked Dana to Brightline on create, with no
        // title; intake fills the title in rather than adding a second link.
        ['pos1', 'updated'],
        ['note', 'created'],
        ['de1', 'created'],
      ])
      expect(results[2]?.label).toBe('CTO at Brightline Health')

      const personId = String(results[1]?.id)
      const companyId = String(results[0]?.id)
      const positions = readList(
        await (await h.client.send('GET', `/v1/positions?person_id=${personId}`, { cookie: owner.cookie })).json(),
      )
      expect(positions).toMatchObject([{ company_id: companyId, title: 'CTO' }])

      const notes = readList(
        await (await h.client.send('GET', `/v1/notes?target_type=person&target_id=${personId}`, { cookie: owner.cookie })).json(),
      )
      expect(notes).toMatchObject([{ body: 'Research note body', pinned: true }])

      const deal = readRecord(
        await (await h.client.send('GET', `/v1/deals/${String(results[4]?.id)}`, { cookie: owner.cookie })).json(),
      )
      expect(deal).toMatchObject({ company_id: companyId, person_ids: [personId] })

      // Apply makes no model call and records no AI run.
      expect(h.provider.requests).toHaveLength(0)
      expect(await runRows(h, owner.workspaceId)).toHaveLength(0)
    })

    it('skips an item whose company was not ticked', async () => {
      const owner = await enabledOwner(h, 'skip@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        cookie: owner.cookie,
        body: {
          items: [
            { key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'Dana Reyes' } },
            { key: 'pos1', kind: 'position', company_key: 'co1', title: 'CTO' },
          ],
        },
      })
      const results = (readRecord(await response.json()).results as Record<string, unknown>[])

      expect(results[1]).toMatchObject({ key: 'pos1', status: 'skipped', id: null })
      expect(String(results[1]?.detail)).toContain('was not created')
    })

    it('adds to an existing person without overwriting what is there', async () => {
      const owner = await enabledOwner(h, 'merge@example.com')
      const created = await h.client.send('POST', '/v1/people', {
        cookie: owner.cookie,
        body: { name: 'Dana R.', summary: 'Keep me', tags: ['investor'] },
      })
      const personId = readString(readRecord(await created.json()), 'id')

      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        cookie: owner.cookie,
        body: {
          items: [
            {
              key: 'person',
              kind: 'person',
              action: 'update',
              existing_id: personId,
              fields: { name: 'Dana Reyes', email: 'dana@brightline.health', summary: 'Replace me', tags: ['Investor', 'hlth-2026'] },
            },
          ],
        },
      })
      const [result] = readRecord(await response.json()).results as Record<string, unknown>[]
      expect(result).toMatchObject({ status: 'updated', id: personId })

      const person = readRecord(await (await h.client.send('GET', `/v1/people/${personId}`, { cookie: owner.cookie })).json())
      expect(person).toMatchObject({
        name: 'Dana R.',
        email: 'dana@brightline.health',
        summary: 'Keep me',
        tags: ['investor', 'hlth-2026'],
      })
    })

    it('reports a refused write and keeps going', async () => {
      const owner = await enabledOwner(h, 'refused@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        cookie: owner.cookie,
        body: {
          items: [
            { key: 'co1', kind: 'company', action: 'existing', existing_id: 'com_missing', fields: { name: 'Gone' } },
            { key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'Dana Reyes' } },
            { key: 'pos1', kind: 'position', company_key: 'co1', title: 'CTO' },
          ],
        },
      })
      const results = (readRecord(await response.json()).results as Record<string, unknown>[])

      expect(results.map((result) => result.status)).toEqual(['failed', 'created', 'skipped'])
    })

    it('writes only what the calling key may write', async () => {
      const owner = await enabledOwner(h, 'scoped@example.com')
      const minted = await h.client.send('POST', '/v1/api-keys', {
        cookie: owner.cookie,
        body: { name: 'intake', kind: 'workspace', scopes: ['ai:write', 'people:write'] },
      })
      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        bearer: readString(await minted.json(), 'secret'),
        body: {
          items: [
            { key: 'co1', kind: 'company', action: 'create', existing_id: null, fields: { name: 'Brightline Health' } },
            { key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'Dana Reyes' } },
          ],
        },
      })

      expect(response.status).toBe(200)
      const results = (readRecord(await response.json()).results as Record<string, unknown>[])
      expect(results.map((result) => [result.key, result.status])).toEqual([
        ['co1', 'failed'],
        ['person', 'created'],
      ])
      expect(results[0]?.detail).toContain('companies:write')
    })

    it('refuses intake and AI settings to a key without the ai scope', async () => {
      const owner = await enabledOwner(h, 'noai@example.com')
      const minted = await h.client.send('POST', '/v1/api-keys', {
        cookie: owner.cookie,
        body: { name: 'reader', kind: 'workspace', scopes: ['write:objects'] },
      })
      const bearer = readString(await minted.json(), 'secret')
      const apply = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        bearer,
        body: { items: [{ key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'A' } }] },
      })

      expect(apply.status).toBe(403)
      expect((await h.client.send('DELETE', '/v1/ai/settings', { bearer })).status).toBe(403)
      expect((await h.client.send('GET', '/v1/ai/runs', { bearer })).status).toBe(403)
    })

    it('refuses a second person item', async () => {
      const owner = await enabledOwner(h, 'twice@example.com')
      const response = await h.client.send('POST', '/v1/ai/person-intake/apply', {
        cookie: owner.cookie,
        body: {
          items: [
            { key: 'person', kind: 'person', action: 'create', existing_id: null, fields: { name: 'A' } },
            { key: 'p2', kind: 'person', action: 'create', existing_id: null, fields: { name: 'B' } },
          ],
        },
      })

      expect(response.status).toBe(422)
    })
  })
})

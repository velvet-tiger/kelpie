import { readFileSync } from 'node:fs'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AiService } from '@kelpie/schemas'

import type { Environment } from '../../lib/config.ts'
import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { createSecretCipher } from '../../lib/secrets.ts'
import { createEntitlementRegistry } from '../../runtime/entitlements.ts'
import { createJobsRuntime } from '../../runtime/jobs.ts'
import { runMigrations } from '../../runtime/migrate.ts'
import type { AgentDispatchOutcome, McpTool } from '../../runtime/module.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT, TEST_SECRET_ENCRYPTION_KEY } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { createAgentTasksModule } from '../agent-tasks/index.ts'
import { agentRegistrations } from '../agent-tasks/schema.ts'
import type { SendDispatch } from '../agent-tasks/dispatch.ts'
import type { Actor } from '../auth/actor.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import { AI_DRAIN_JOB_NAME } from './drainJob.ts'
import { createAiModule } from './index.ts'
import type { AiModuleOptions } from './index.ts'
import type { AiRunSettledData } from './events.ts'
import type { AiCompletionRequest, AiCompletionResult, AiProviderPort, AiTokenUsage } from './provider.ts'
import { resealAiSecrets } from './reseal.ts'
import { AI_RUNS_LIMIT, monthWindowStart } from './rules.ts'
import { aiRuns, aiSettings } from './schema.ts'

/**
 * The `ai` module against the real test database: setup in both key modes,
 * in-process dispatch through the dispatcher the module provides, metering, concurrency, the
 * `workspace.deleted` handler, and Kelpie reading records itself, calling the
 * model with no tools, validating the JSON proposal, and applying every
 * operation through MCP tools with the synthetic AI actor.
 *
 * Most suites stub the tools through the module's `tools` seam, so a test can
 * see exactly which reads and writes the executor made. The last suite uses
 * the real registry and core's real dispatch engine, looped back into the
 * app, to prove the pieces meet.
 *
 * These tests began in the cloud assembly (`kelpie-cloud/test/ai.test.ts`)
 * and moved here with the module.
 */

// Its own database: the module's migrations add `ai_runs` and `ai_settings`,
// which must not leak into the core database other files on this worker use.
const connectionString = testDatabaseUrl(process.env, 'ai')

const cipher = createSecretCipher({ SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY })

interface QueueEntry {
  readonly result?: AiCompletionResult
  readonly promise?: Promise<AiCompletionResult>
}

interface AiProviderFake extends AiProviderPort {
  /** Every completion request the executor made, in order. */
  readonly requests: AiCompletionRequest[]
  /** Every key a port was built with, in order. */
  readonly keys: string[]
  queue(result: AiCompletionResult): void
  /** A reply the test resolves later, to hold a run `running`. */
  queueDeferred(): (result: AiCompletionResult) => void
  reset(): void
}

function makeProviderFake(): AiProviderFake {
  const entries: QueueEntry[] = []
  const requests: AiCompletionRequest[] = []
  const keys: string[] = []

  return {
    requests,
    keys,
    async complete(request) {
      requests.push(request)
      const entry = entries.shift()

      if (entry === undefined) {
        throw new Error(`AI provider fake ran out of queued replies after ${String(requests.length)} calls`)
      }
      if (entry.result !== undefined) {
        return entry.result
      }
      if (entry.promise === undefined) {
        throw new Error('Deferred entry is missing its promise')
      }

      return entry.promise
    },
    queue(result) {
      entries.push({ result })
    },
    queueDeferred() {
      let resolver: ((value: AiCompletionResult) => void) | undefined
      const promise = new Promise<AiCompletionResult>((resolve) => {
        resolver = resolve
      })
      if (resolver === undefined) {
        throw new Error('Promise resolver was never assigned')
      }
      entries.push({ promise })
      return resolver
    },
    reset() {
      entries.length = 0
      requests.length = 0
      keys.length = 0
    },
  }
}

/** Both providers answer from one fake, and record the key each port was built with. */
function fakeProviders(fake: AiProviderFake): NonNullable<AiModuleOptions['providers']> {
  const build = (options: { readonly apiKey: string }): AiProviderPort => {
    fake.keys.push(options.apiKey)
    return fake
  }

  return { openai: build, anthropic: build }
}

function proposal(payload: { readonly summary: string; readonly operations?: readonly unknown[] }): string {
  return JSON.stringify({ summary: payload.summary, operations: payload.operations ?? [] })
}

function endTurn(text: string, usage: AiTokenUsage = { inputTokens: 40, outputTokens: 25 }): AiCompletionResult {
  return { stopReason: 'end_turn', text, usage }
}

async function until<T>(
  predicate: () => Promise<T | undefined>,
  { timeoutMs = 3000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const answer = await predicate()
    if (answer !== undefined) return answer
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`until() timed out after ${String(timeoutMs)}ms`)
}

interface DispatchOptions {
  readonly runId: string
  readonly workspaceId: string
  readonly taskId?: string
  readonly targetType?: string
  readonly targetId?: string
  readonly prompt?: string
  readonly basePrompt?: string | null
  readonly context?: Record<string, unknown>
}

/**
 * A dispatch payload in core's shape: `prompt` (external-agent framing) and
 * `base_prompt` (the general request). `basePrompt: null` omits the second,
 * which is what a dispatch from a core older than the split looks like.
 */
function dispatchBody(options: DispatchOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    run_id: options.runId,
    workspace_id: options.workspaceId,
    task_id: options.taskId ?? 'person.enrich',
    target_type: options.targetType ?? 'person',
    target_id: options.targetId ?? 'per_test_1',
    prompt:
      options.prompt ??
      'You are operating on the Kelpie workspace **Acme** via MCP / the public API.\n\nDo the enrich thing.',
    context: options.context ?? {
      target_label: 'Ada Lovelace',
      deep_link: 'https://kelpie.test/people/per_test_1',
      pinned_note_ids: [],
      open_plan_ids: [],
      open_decision_ids: [],
    },
  }

  if (options.basePrompt !== null) {
    payload.base_prompt = options.basePrompt ?? 'Do the enrich thing'
  }

  return payload
}

interface StubToolCall {
  readonly toolName: string
  readonly input: unknown
  readonly actor: Actor
}

/** `throwsOnce` makes the next call throw once, then behave normally. */
interface StubToolBehavior {
  readonly response?: unknown
  readonly throwsOnce?: string
}

function stubTool(name: string, log: StubToolCall[], behaviors: Map<string, StubToolBehavior>, fixed?: unknown): McpTool {
  const state = { thrown: false }

  return {
    name,
    description: `Stub tool ${name} for the AI executor tests.`,
    scope: 'people:write',
    inputSchema: z.record(z.string(), z.unknown()),
    invoke(rawInput: unknown, actor: Actor): Promise<unknown> {
      log.push({ toolName: name, input: rawInput, actor })
      const behavior = behaviors.get(name) ?? {}
      if (behavior.throwsOnce !== undefined && !state.thrown) {
        state.thrown = true
        return Promise.reject(new Error(behavior.throwsOnce))
      }
      return Promise.resolve(behavior.response ?? fixed ?? { id: `${name}_result_1`, ok: true })
    },
  }
}

interface Harness {
  readonly app: TestApp
  readonly client: TestClient
  readonly provider: AiProviderFake
  readonly toolLog: StubToolCall[]
  readonly behaviors: Map<string, StubToolBehavior>
  /** Answers `ai.runs.limit`; `undefined` leaves it unlimited. */
  limit: number | undefined
  /** Stops this harness's job worker, so the next suite's worker takes `ai.drain` alone. */
  close(): Promise<void>
}

interface HarnessOptions {
  readonly keyMode: 'workspace' | 'deployment'
  /** The AI service the install offers. The module's default, `custom`, when absent. */
  readonly service?: AiService
  readonly environment?: Environment
  /** Stub the tools (the default) or use the real registry. */
  readonly realTools?: boolean
  readonly send?: SendDispatch
}

async function buildHarness(database: TestDatabase, options: HarnessOptions): Promise<Harness> {
  const provider = makeProviderFake()
  const toolLog: StubToolCall[] = []
  const behaviors = new Map<string, StubToolBehavior>()
  const entitlements = createEntitlementRegistry()
  const harness: { limit: number | undefined } = { limit: undefined }

  entitlements.provide((_workspaceId, capability) =>
    Promise.resolve(
      capability.name === AI_RUNS_LIMIT.name && harness.limit !== undefined
        ? { kind: 'limit' as const, limit: harness.limit }
        : undefined,
    ),
  )

  const stubs: readonly McpTool[] = [
    stubTool('people_get', toolLog, behaviors, { id: 'per_test_1', name: 'Ada Lovelace', summary: '' }),
    stubTool('companies_get', toolLog, behaviors, { id: 'co_test_1', name: 'Acme Corp' }),
    stubTool('enquiries_get', toolLog, behaviors, { id: 'enq_test_1', name: 'Pilot request' }),
    stubTool('notes_get', toolLog, behaviors, { id: 'nte_seed_1', body: 'existing pinned note' }),
    stubTool('plan_items_get', toolLog, behaviors),
    stubTool('decisions_get', toolLog, behaviors),
    stubTool('handbook_pages_list', toolLog, behaviors, {
      data: [{ slug: 'agent-faq', body: '...' }],
      next_cursor: null,
    }),
    stubTool('dashboard_get', toolLog, behaviors, { counts: { deals: 0 } }),
    stubTool('people_update', toolLog, behaviors),
    stubTool('enquiries_update', toolLog, behaviors),
    stubTool('notes_create', toolLog, behaviors),
    stubTool('notes_update', toolLog, behaviors),
    stubTool('plan_items_create', toolLog, behaviors),
    stubTool('decisions_create', toolLog, behaviors),
    stubTool('positions_create', toolLog, behaviors),
  ]

  const aiModule = createAiModule({
    keyMode: options.keyMode,
    ...(options.service === undefined ? {} : { service: options.service }),
    providers: fakeProviders(provider),
    ...(options.realTools === true ? {} : { tools: () => stubs }),
  })
  const modules =
    options.send === undefined
      ? [...coreModules, aiModule]
      : [
          ...coreModules.filter((module) => module.id !== 'agent-tasks'),
          createAgentTasksModule(coreMigrationsDirectory, { send: options.send }),
          aiModule,
        ]

  // A real pg-boss runtime, because a dispatched run only executes when a
  // worker takes its `ai.drain` job. One per harness: each suite's handler
  // closes over its own fakes, so two workers on one queue would cross them.
  const silentLogger = createLogger({ level: 'error', transports: [createCaptureTransport(() => undefined)] })
  if (connectionString === undefined) {
    throw new Error('unreachable: the suite is skipped without a connection string')
  }
  const jobs = createJobsRuntime({ connectionString, logger: silentLogger, pollingIntervalSeconds: 0.5 })

  const app = await createTestApp({
    modules,
    environment: { ...TEST_ENVIRONMENT, ...options.environment },
    services: createTestServices({ db: database.db, enqueueOnTx: jobs.enqueueOnTx }),
    entitlements,
    jobs: jobs.registry,
  })

  // Core's tables are migrated by `connectTestDatabase`; this adds the
  // module's own directory, on the `ai` database `connectionString` names.
  // A no-op after the first suite in this worker.
  await runMigrations(database.db, app.contributions.schemas, silentLogger)

  await jobs.migrate()
  await jobs.start()
  await jobs.startWorking()

  return {
    app,
    client: createTestClient(app.app, app.services.db),
    provider,
    toolLog,
    behaviors,
    get limit() {
      return harness.limit
    },
    set limit(value) {
      harness.limit = value
    },
    close: () => jobs.stop(),
  }
}

const DEPLOYMENT_ENVIRONMENT: Environment = {
  AI_PROVIDER: 'openai',
  AI_API_KEY: 'sk-deployment-key-0001',
}

async function enabledWorkspace(
  h: Harness,
  email = 'ai-admin@example.com',
  body?: Record<string, unknown>,
): Promise<{ readonly cookie: string; readonly workspaceId: string }> {
  const owner = await h.client.owner(email)
  await h.app.services.events.drain()

  const response = await h.client.send('POST', '/v1/ai/settings', {
    cookie: owner.cookie,
    ...(body === undefined ? {} : { body }),
  })
  if (response.status !== 200) {
    throw new Error(`Enabling ai answered ${String(response.status)}: ${await response.text()}`)
  }

  return { cookie: owner.cookie, workspaceId: owner.workspaceId }
}

/**
 * Hands a payload to the dispatcher the module provided, the way core's
 * agent-tasks engine does for the "Kelpie AI" row.
 */
function deliver(h: Harness, payload: Record<string, unknown>): Promise<AgentDispatchOutcome> {
  const dispatcher = h.app.contributions.agentDispatchers.get('ai')
  if (dispatcher === undefined) throw new Error('the ai module provided no dispatcher')

  return dispatcher(payload)
}

interface RunRow {
  readonly status: string
  readonly model: string
  readonly prompt: string | null
  readonly context: unknown
  readonly operations: unknown
  readonly failureReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly modelRequests: number | null
  readonly webSearches: number | null
}

async function fetchRun(h: Harness, agentRunId: string): Promise<RunRow | undefined> {
  const rows = await h.app.services.db
    .select({
      status: aiRuns.status,
      model: aiRuns.model,
      prompt: aiRuns.prompt,
      context: aiRuns.context,
      operations: aiRuns.operations,
      failureReason: aiRuns.failureReason,
      inputTokens: aiRuns.inputTokens,
      outputTokens: aiRuns.outputTokens,
      modelRequests: aiRuns.modelRequests,
      webSearches: aiRuns.webSearches,
    })
    .from(aiRuns)
    .where(eq(aiRuns.agentRunId, agentRunId))
    .limit(1)

  return rows[0]
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

/** A settled run row with id `ai_<suffix>`, for tests that seed the log directly. */
function settledRow(workspaceId: string, suffix: string, createdAt: Date): typeof aiRuns.$inferInsert {
  return {
    id: `ai_${suffix}`,
    workspaceId,
    agentRunId: `run_${suffix}`,
    taskId: 'person.enrich',
    targetType: 'person',
    targetId: 'per_x',
    status: 'succeeded',
    model: 'gpt-5-mini',
    prompt: 'noop',
    context: {},
    createdAt,
    updatedAt: createdAt,
  }
}

/** The workspace's run ids, seeded ones sorted, with any run the module minted shown as `new`. */
async function runIds(h: Harness, workspaceId: string): Promise<readonly string[]> {
  const rows = await h.app.services.db
    .select({ id: aiRuns.id, agentRunId: aiRuns.agentRunId })
    .from(aiRuns)
    .where(eq(aiRuns.workspaceId, workspaceId))

  return rows
    .map((row) => (row.agentRunId === 'run_after_trim' ? 'new' : row.id))
    .sort()
}

/** How many `ai.drain` jobs the queue holds for a workspace, in any state. */
async function drainJobsFor(h: Harness, workspaceId: string): Promise<number> {
  const rows = await h.app.services.db.execute<{ count: number }>(
    sql`select count(*)::int as count from pgboss.job where name = ${AI_DRAIN_JOB_NAME} and data->>'workspaceId' = ${workspaceId}`,
  )

  return [...rows][0]?.count ?? 0
}

function settled(h: Harness, agentRunId: string): Promise<RunRow> {
  return until(async () => {
    const found = await fetchRun(h, agentRunId)
    return found !== undefined && found.status !== 'queued' && found.status !== 'running' ? found : undefined
  })
}

describe.skipIf(connectionString === undefined)('ai', () => {
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

  describe('deployment key mode', () => {
    let h: Harness

    afterAll(async () => {
      await h.close()
    })
    const settledEvents: AiRunSettledData[] = []

    beforeAll(async () => {
      // Kelpie Cloud's shape: the hosted service on the deployment's key.
      h = await buildHarness(database, { keyMode: 'deployment', service: 'kelpie_ai', environment: DEPLOYMENT_ENVIRONMENT })
      h.app.services.events.subscribe('ai.run.settled', (event) => {
        settledEvents.push(event.data)
      })
    })

    beforeEach(async () => {
      await database.truncateAll()
      settledEvents.length = 0
      h.provider.reset()
      h.toolLog.length = 0
      h.behaviors.clear()
      h.limit = undefined
    })

    it('creates one Kelpie AI registration that core dispatches in-process', async () => {
      const owner = await h.client.owner('rotator@example.com')
      await h.app.services.events.drain()

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie })).status).toBe(200)
      }

      const registrations = await h.app.services.db
        .select()
        .from(agentRegistrations)
        .where(and(eq(agentRegistrations.workspaceId, owner.workspaceId), eq(agentRegistrations.name, 'Kelpie AI')))
      expect(registrations).toHaveLength(1)
      expect(registrations[0]).toMatchObject({
        endpoint: 'module:ai',
        authHeaderEncrypted: null,
        managedBy: 'ai',
        settingsPath: '/admin/ai',
      })

      // Nothing sealed for dispatch any more.
      const [settings] = await h.app.services.db.select().from(aiSettings).where(eq(aiSettings.workspaceId, owner.workspaceId))
      expect(settings?.dispatchSecretEncrypted).toBeNull()
    })

    it('rewrites a row stored by the HTTP version on the next save', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)
      await h.app.services.db
        .update(agentRegistrations)
        .set({ endpoint: 'http://localhost:5173/v1/public/ai/dispatch', authHeaderEncrypted: cipher.seal('Bearer aidsp_old') })
        .where(eq(agentRegistrations.workspaceId, workspaceId))

      expect((await h.client.send('POST', '/v1/ai/settings', { cookie })).status).toBe(200)

      const [row] = await h.app.services.db.select().from(agentRegistrations).where(eq(agentRegistrations.workspaceId, workspaceId))
      expect(row).toMatchObject({ endpoint: 'module:ai', authHeaderEncrypted: null })
    })

    it('refuses a settings body: the deployment manages provider, key and model', async () => {
      const owner = await h.client.owner()
      const response = await h.client.send('POST', '/v1/ai/settings', {
        cookie: owner.cookie,
        body: { provider: 'anthropic', api_key: 'sk-ant-mine-000000' },
      })

      expect(response.status).toBe(400)
      expect(readString(readRecord(await response.json()).error, 'message')).toContain('manages the AI provider')
    })

    it('leaves an admin agent called Kelpie AI alone on enable and disable', async () => {
      const owner = await h.client.owner('namesake@example.com')
      await h.app.services.events.drain()

      const now = new Date()
      await h.app.services.db.insert(agentRegistrations).values({
        id: 'ag_admin_namesake',
        workspaceId: owner.workspaceId,
        name: 'Kelpie AI',
        endpoint: 'https://agent.example.com/run',
        createdAt: now,
        updatedAt: now,
      })

      expect((await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie })).status).toBe(200)

      const afterEnable = await h.app.services.db
        .select({ id: agentRegistrations.id, endpoint: agentRegistrations.endpoint, managedBy: agentRegistrations.managedBy })
        .from(agentRegistrations)
        .where(eq(agentRegistrations.workspaceId, owner.workspaceId))
      expect(afterEnable).toHaveLength(2)
      expect(afterEnable.find((row) => row.id === 'ag_admin_namesake')).toEqual({
        id: 'ag_admin_namesake',
        endpoint: 'https://agent.example.com/run',
        managedBy: null,
      })

      expect((await h.client.send('DELETE', '/v1/ai/settings', { cookie: owner.cookie })).status).toBeLessThan(300)

      const afterDisable = await h.app.services.db
        .select({ id: agentRegistrations.id })
        .from(agentRegistrations)
        .where(eq(agentRegistrations.workspaceId, owner.workspaceId))
      expect(afterDisable).toEqual([{ id: 'ag_admin_namesake' }])
    })

    it('makes core refuse to edit or remove the Kelpie AI row', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)

      const rows = await h.app.services.db
        .select({ id: agentRegistrations.id })
        .from(agentRegistrations)
        .where(eq(agentRegistrations.workspaceId, workspaceId))
      const id = rows[0]!.id

      expect((await h.client.send('PATCH', `/v1/agents/${id}`, { cookie, body: { name: 'Renamed' } })).status).toBe(409)
      expect((await h.client.send('DELETE', `/v1/agents/${id}`, { cookie })).status).toBe(409)
    })

    it('claims a pre-0.16 Kelpie AI row only where AI is enabled (migration 0003)', async () => {
      const { workspaceId } = await enabledWorkspace(h, 'legacy@example.com')
      await h.app.services.db
        .update(agentRegistrations)
        .set({ managedBy: null, settingsPath: null })
        .where(eq(agentRegistrations.workspaceId, workspaceId))

      const other = await h.client.owner('no-ai@example.com')
      await h.app.services.events.drain()
      const now = new Date()
      await h.app.services.db.insert(agentRegistrations).values({
        id: 'ag_other_namesake',
        workspaceId: other.workspaceId,
        name: 'Kelpie AI',
        endpoint: 'https://agent.example.com/run',
        createdAt: now,
        updatedAt: now,
      })

      const migration = readFileSync(
        new URL('../../../module-migrations/ai/0003_claim_kelpie_agent.sql', import.meta.url),
        'utf8',
      )
      await h.app.services.db.execute(sql.raw(migration))
      // A second run changes nothing and does not trip the unique index.
      await h.app.services.db.execute(sql.raw(migration))

      const claimed = await h.app.services.db
        .select({ managedBy: agentRegistrations.managedBy, settingsPath: agentRegistrations.settingsPath })
        .from(agentRegistrations)
        .where(eq(agentRegistrations.workspaceId, workspaceId))
      expect(claimed).toEqual([{ managedBy: 'ai', settingsPath: '/admin/ai' }])

      const untouched = await h.app.services.db
        .select({ managedBy: agentRegistrations.managedBy })
        .from(agentRegistrations)
        .where(eq(agentRegistrations.id, 'ag_other_namesake'))
      expect(untouched).toEqual([{ managedBy: null }])
    })

    it('reads the context pack and applies the proposal in one call', async () => {
      const { workspaceId } = await enabledWorkspace(h)

      h.provider.queue(
        endTurn(
          proposal({
            summary: 'Enriched Ada Lovelace and added a note.',
            operations: [
              { kind: 'update_target', fields: { summary: 'Prolific mathematician; likes email.', tags: ['warm'] } },
              { kind: 'append_note', body: 'Prefers email replies.', pinned: false },
            ],
          }),
          { inputTokens: 100, outputTokens: 20 },
        ),
      )

      const response = await deliver(
        h,
        dispatchBody({
          runId: 'run_test_1',
          workspaceId,
          context: {
            target_label: 'Ada Lovelace',
            pinned_note_ids: ['nte_seed_1'],
            open_plan_ids: [],
            open_decision_ids: [],
            handbook_slugs: ['agent-faq'],
          },
        }),
      )
      expect(response.status).toBe(202)

      const row = await settled(h, 'run_test_1')
      expect(row.status).toBe('succeeded')
      // No AI_MODEL in the environment: the provider's default.
      expect(row.model).toBe('gpt-5.6-luna')
      // Metadata only once settled: the prompt and the context bag hold personal data.
      expect(row.prompt).toBeNull()
      expect(row.context).toBeNull()
      expect(row.inputTokens).toBe(100)
      expect(row.outputTokens).toBe(20)

      // The port was built with the deployment's key.
      expect(h.provider.keys).toEqual(['sk-deployment-key-0001'])

      // Exactly one model call: no tool loop.
      expect(h.provider.requests).toHaveLength(1)
      expect(h.provider.requests[0]?.instructions).toMatch(/no tools/)
      expect(h.provider.requests[0]?.responseFormat.name).toBe('kelpie_proposal')

      const reads = h.toolLog.filter((entry) => entry.toolName === 'people_get' || entry.toolName === 'notes_get')
      expect(reads.map((entry) => entry.toolName).sort()).toEqual(['notes_get', 'people_get'])

      const writes = h.toolLog.filter((entry) => entry.toolName === 'people_update' || entry.toolName === 'notes_create')
      expect(writes.map((entry) => entry.toolName).sort()).toEqual(['notes_create', 'people_update'])
      for (const entry of writes) {
        expect(entry.actor.workspaceId).toBe(workspaceId)
        expect(entry.actor.kind).toBe('api_key')
        expect(entry.actor.role).toBe('admin')
      }

      const operations = row.operations as readonly { kind: string; status: string }[]
      expect(operations.map((op) => `${op.kind}:${op.status}`).sort()).toEqual([
        'append_note:applied',
        'update_target:applied',
      ])

      const userMessage = h.provider.requests[0]?.messages[0]?.text ?? ''
      expect(userMessage).toContain('Do the enrich thing')
      expect(userMessage).not.toContain('via MCP / the public API')
    })

    it('runs on an Enquiry target, which the cloud copy refused as unknown', async () => {
      const { workspaceId } = await enabledWorkspace(h)

      h.provider.queue(
        endTurn(proposal({ summary: 'Noted the enquiry.', operations: [{ kind: 'append_note', body: 'Asked for a pilot.', pinned: false }] })),
      )

      await deliver(
        h,
        dispatchBody({
          runId: 'run_enquiry',
          workspaceId,
          taskId: 'enquiry.triage',
          targetType: 'enquiry',
          targetId: 'enq_test_1',
          context: { target_label: 'Pilot request' },
        }),
      )

      const row = await settled(h, 'run_enquiry')
      expect(row.failureReason).toBeNull()
      expect(row.status).toBe('succeeded')
      expect(h.toolLog.some((entry) => entry.toolName === 'enquiries_get')).toBe(true)
    })

    it('falls back to `prompt` when core did not send `base_prompt`', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn(proposal({ summary: 'fallback' })))

      await deliver(h, dispatchBody({ runId: 'run_fallback', workspaceId, basePrompt: null }))
      await settled(h, 'run_fallback')

      expect(h.provider.requests[0]?.messages[0]?.text ?? '').toContain('via MCP / the public API')
    })

    it('strips off-limits fields from an update_target and records the drop', async () => {
      const { workspaceId } = await enabledWorkspace(h)

      h.provider.queue(
        endTurn(
          proposal({
            summary: 'Filed a note; ignored the disallowed field.',
            operations: [{ kind: 'update_target', fields: { summary: 'Kept this.', stage_id: 'stg_forbidden' } }],
          }),
        ),
      )

      await deliver(h, dispatchBody({ runId: 'run_drop_fields', workspaceId }))
      const row = await settled(h, 'run_drop_fields')

      const operations = row.operations as readonly { kind: string; status: string; detail: string }[]
      expect(
        operations.some((op) => op.kind === 'update_target' && op.status === 'skipped' && op.detail.includes('stage_id')),
      ).toBe(true)
      expect(operations.some((op) => op.kind === 'update_target' && op.status === 'applied')).toBe(true)
      expect(h.toolLog.find((entry) => entry.toolName === 'people_update')?.input).toEqual({
        id: 'per_test_1',
        summary: 'Kept this.',
      })
    })

    it('issues one repair turn on invalid JSON and fails after a second bad reply', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn('this is not JSON', { inputTokens: 10, outputTokens: 5 }))
      h.provider.queue(endTurn('still not JSON', { inputTokens: 10, outputTokens: 5 }))

      await deliver(h, dispatchBody({ runId: 'run_bad_json', workspaceId }))
      const row = await settled(h, 'run_bad_json')

      expect(row.status).toBe('failed')
      expect(h.provider.requests).toHaveLength(2)
      expect(h.provider.requests[1]?.messages).toHaveLength(3)
      expect(row.failureReason ?? '').toMatch(/valid proposal/)
    })

    it('adds up requests and searches over the repair turn, and reports the settled run with counts only', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn('this is not JSON', { inputTokens: 10, outputTokens: 5, requests: 2, webSearches: 1 }))
      h.provider.queue(endTurn(proposal({ summary: 'ok' }), { inputTokens: 12, outputTokens: 6, requests: 1, webSearches: 0 }))

      await deliver(h, dispatchBody({ runId: 'run_counts', workspaceId }))
      const row = await settled(h, 'run_counts')

      expect(row.status).toBe('succeeded')
      expect(row).toMatchObject({ inputTokens: 22, outputTokens: 11, modelRequests: 3, webSearches: 1 })

      await h.app.services.events.drain()
      expect(settledEvents).toHaveLength(1)
      expect(settledEvents[0]).toEqual({
        runId: expect.stringMatching(/^ai_/) as unknown,
        agentRunId: 'run_counts',
        taskId: 'person.enrich',
        status: 'succeeded',
        model: 'gpt-5.6-luna',
        inputTokens: 22,
        outputTokens: 11,
        modelRequests: 3,
        webSearches: 1,
        createdAt: expect.any(String) as unknown,
        settledAt: expect.any(String) as unknown,
      })
    })

    it('counts a port that does not report requests as one request each', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn(proposal({ summary: 'ok' }), { inputTokens: 1, outputTokens: 1 }))

      await deliver(h, dispatchBody({ runId: 'run_old_port', workspaceId }))
      const row = await settled(h, 'run_old_port')

      expect(row).toMatchObject({ modelRequests: 1, webSearches: 0 })
    })

    it('reports a failed run as settled, with what it spent', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn('this is not JSON', { inputTokens: 10, outputTokens: 5 }))
      h.provider.queue(endTurn('still not JSON', { inputTokens: 10, outputTokens: 5 }))

      await deliver(h, dispatchBody({ runId: 'run_failed_counts', workspaceId }))
      await settled(h, 'run_failed_counts')

      await h.app.services.events.drain()
      expect(settledEvents).toMatchObject([
        { status: 'failed', inputTokens: 20, outputTokens: 10, modelRequests: 2, webSearches: 0 },
      ])
    })

    it('records a per-operation failure without aborting the rest', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.behaviors.set('notes_create', { throwsOnce: 'notes_create failed for test' })

      h.provider.queue(
        endTurn(
          proposal({
            summary: 'One op fails, one succeeds.',
            operations: [
              { kind: 'append_note', body: 'first attempt', pinned: false },
              { kind: 'update_target', fields: { summary: 'still applied' } },
            ],
          }),
        ),
      )

      await deliver(h, dispatchBody({ runId: 'run_partial', workspaceId }))
      const row = await settled(h, 'run_partial')

      const operations = row.operations as readonly { kind: string; status: string; detail: string }[]
      expect(operations.find((op) => op.kind === 'append_note')?.status).toBe('failed')
      expect(operations.find((op) => op.kind === 'append_note')?.detail).toContain('notes_create failed for test')
      expect(operations.find((op) => op.kind === 'update_target')?.status).toBe('applied')
    })

    it('records a refusal as failed with the provider reason', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue({
        stopReason: 'refusal',
        text: '',
        usage: { inputTokens: 12, outputTokens: 0 },
        failure: { code: 'content_filter', message: 'The provider declined this task' },
      })

      await deliver(h, dispatchBody({ runId: 'run_refused', workspaceId }))
      const row = await settled(h, 'run_refused')

      expect(row.status).toBe('failed')
      expect(row.failureReason).toBe('The provider declined this task')
    })

    it('hides a provider error behind the generic message: the key is the operator’s', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue({
        stopReason: 'failed',
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: { code: 'invalid_api_key', message: 'The OpenAI API key was rejected.' },
      })

      await deliver(h, dispatchBody({ runId: 'run_provider_down', workspaceId }))
      const row = await settled(h, 'run_provider_down')

      expect(row.status).toBe('failed')
      expect(row.failureReason).toBe('The AI service was unavailable for this run. Try again shortly.')
      expect(h.app.logLines.some((line) => line.includes('ai provider call failed') && line.includes('invalid_api_key'))).toBe(true)
    })

    it('records a max_tokens truncation as failed', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue({ stopReason: 'max_tokens', text: '{"summary":"Partial…', usage: { inputTokens: 200, outputTokens: 4096 } })

      await deliver(h, dispatchBody({ runId: 'run_trunc', workspaceId }))
      const row = await settled(h, 'run_trunc')

      expect(row.status).toBe('failed')
      expect(row.failureReason).toContain('AI_MAX_TOKENS')
    })

    it('refuses a dispatch for a workspace that has not enabled AI, with a reason for the run log', async () => {
      const owner = await h.client.owner('not-enabled@example.com')

      const outcome = await deliver(h, dispatchBody({ runId: 'run_not_enabled', workspaceId: owner.workspaceId }))

      expect(outcome).toEqual({
        delivered: false,
        status: 409,
        reason: 'AI is not enabled for this workspace; an admin can enable it in AI settings',
      })
      expect(await fetchRun(h, 'run_not_enabled')).toBeUndefined()
    })

    it('refuses a payload that is not a dispatch', async () => {
      const outcome = await deliver(h, { run_id: 'run_bad' })

      expect(outcome.delivered).toBe(false)
      expect(outcome.status).toBe(422)
      expect(outcome.reason).toContain('workspace_id')
    })

    it('answers 403 entitlement_required past the monthly limit', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.limit = 3

      for (let n = 1; n <= 3; n += 1) {
        h.provider.queue(endTurn(proposal({ summary: `run ${String(n)}` }), { inputTokens: 1, outputTokens: 1 }))
        expect((await deliver(h, dispatchBody({ runId: `run_cap_${String(n)}`, workspaceId }))).status).toBe(202)
        await settled(h, `run_cap_${String(n)}`)
      }

      const blocked = await deliver(h, dispatchBody({ runId: 'run_cap_4', workspaceId }))
      expect(blocked).toEqual({ delivered: false, status: 403, reason: 'This workspace has used its monthly AI runs' })
      expect(await fetchRun(h, 'run_cap_4')).toBeUndefined()
    })

    it('refuses every run when the limit is 0', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.limit = 0

      expect((await deliver(h, dispatchBody({ runId: 'run_zero', workspaceId }))).status).toBe(403)
    })

    it('queues beyond the concurrency cap and chains completions', async () => {
      const { workspaceId } = await enabledWorkspace(h)

      // The default cap is 2. Hold two runs, then a third waits.
      const resolveFirst = h.provider.queueDeferred()
      const resolveSecond = h.provider.queueDeferred()
      h.provider.queue(endTurn(proposal({ summary: 'third' }), { inputTokens: 10, outputTokens: 10 }))

      await deliver(h, dispatchBody({ runId: 'run_hold_1', workspaceId }))
      await deliver(h, dispatchBody({ runId: 'run_hold_2', workspaceId }))
      await until(async () => ((await fetchRun(h, 'run_hold_2'))?.status === 'running' ? true : undefined))

      expect((await deliver(h, dispatchBody({ runId: 'run_third', workspaceId }))).status).toBe(202)
      expect((await fetchRun(h, 'run_third'))?.status).toBe('queued')

      resolveFirst(endTurn(proposal({ summary: 'first' }), { inputTokens: 5, outputTokens: 5 }))
      resolveSecond(endTurn(proposal({ summary: 'second' }), { inputTokens: 5, outputTokens: 5 }))

      expect((await settled(h, 'run_third')).status).toBe('succeeded')
    })

    it('is idempotent when the same run_id is dispatched twice', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn(proposal({ summary: 'once' }), { inputTokens: 1, outputTokens: 1 }))

      await deliver(h, dispatchBody({ runId: 'run_dupe', workspaceId }))
      await settled(h, 'run_dupe')

      expect((await deliver(h, dispatchBody({ runId: 'run_dupe', workspaceId }))).status).toBe(202)

      const rows = await h.app.services.db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.agentRunId, 'run_dupe'))
      expect(rows).toHaveLength(1)
      expect(h.provider.requests).toHaveLength(1)

      // One job for the one recorded run: the redelivery enqueued nothing.
      expect(await drainJobsFor(h, workspaceId)).toBe(1)
    })

    it('records the run and its job in the request, and runs the model on the worker', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      h.provider.queue(endTurn(proposal({ summary: 'on the worker' }), { inputTokens: 1, outputTokens: 1 }))

      // The dispatch answers once the row and the job commit, before any model call.
      expect((await deliver(h, dispatchBody({ runId: 'run_on_worker', workspaceId }))).status).toBe(202)
      expect(await drainJobsFor(h, workspaceId)).toBe(1)

      expect((await settled(h, 'run_on_worker')).status).toBe('succeeded')
      expect(h.provider.requests).toHaveLength(1)
    })

    it('sweeps a stale running row to failed on the next dispatch', async () => {
      const { workspaceId } = await enabledWorkspace(h)

      await h.app.services.db.insert(aiRuns).values({
        id: 'ai_test_stale',
        workspaceId,
        agentRunId: 'run_stale',
        taskId: 'person.enrich',
        targetType: 'person',
        targetId: 'per_x',
        status: 'running',
        model: 'gpt-5-mini',
        prompt: 'noop',
        context: {},
        createdAt: new Date(Date.now() - 30 * 60_000),
        updatedAt: new Date(Date.now() - 30 * 60_000),
      })

      h.provider.queue(endTurn(proposal({ summary: 'ok' }), { inputTokens: 1, outputTokens: 1 }))
      await deliver(h, dispatchBody({ runId: 'run_after_stale', workspaceId }))

      const stale = await until(async () => {
        const found = await fetchRun(h, 'run_stale')
        return found?.status === 'failed' ? found : undefined
      })
      expect(stale.failureReason).toContain('AI_RUN_TIMEOUT_MINUTES')
      expect(stale.prompt).toBeNull()
      expect(stale.context).toBeNull()

      // The swept run is reported too, with no counts: nothing recorded them.
      await settled(h, 'run_after_stale')
      await h.app.services.events.drain()
      expect(settledEvents.find((event) => event.runId === 'ai_test_stale')).toMatchObject({
        agentRunId: 'run_stale',
        status: 'failed',
        inputTokens: null,
        modelRequests: null,
        webSearches: null,
      })
    })

    it('forgets a workspace when the workspace is deleted', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)

      const deleted = await h.client.send('DELETE', `/v1/workspaces/${workspaceId}?name=Acme`, { cookie })
      expect(deleted.status).toBeLessThan(300)
      await h.app.services.events.drain()

      const settings = await h.app.services.db
        .select({ workspaceId: aiSettings.workspaceId })
        .from(aiSettings)
        .where(eq(aiSettings.workspaceId, workspaceId))
      expect(settings).toHaveLength(0)

      const runs = await h.app.services.db.select({ id: aiRuns.id }).from(aiRuns).where(eq(aiRuns.workspaceId, workspaceId))
      expect(runs).toHaveLength(0)
    })

    it('exposes settings and the run log through /v1/ai/*', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)

      h.provider.queue(endTurn(proposal({ summary: 'listed' }), { inputTokens: 2, outputTokens: 3 }))
      await deliver(h, dispatchBody({ runId: 'run_listing', workspaceId }))
      await settled(h, 'run_listing')

      const settingsResponse = await h.client.send('GET', '/v1/ai/settings', { cookie })
      expect(settingsResponse.status).toBe(200)
      const settings = readRecord(await settingsResponse.json())
      expect(settings).toMatchObject({
        service: 'kelpie_ai',
        key_mode: 'deployment',
        configured: true,
        enabled: true,
        provider: 'openai',
        model: 'gpt-5.6-luna',
        key_source: 'environment',
        // The deployment's key is never hinted at.
        key_hint: null,
        monthly_limit: null,
        runs_this_month: 1,
      })

      const runs = readList(await (await h.client.send('GET', '/v1/ai/runs', { cookie })).json())
      expect(runs).toHaveLength(1)
      // Metadata only: the model's reply is never stored or served.
      expect(runs[0]).not.toHaveProperty('output')
      expect(runs[0]?.operations).toEqual([])
    })

    it('pages the run log with a cursor', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)
      const base = Date.now() - 60_000
      await h.app.services.db.insert(aiRuns).values(
        [0, 1, 2].map((index) => settledRow(workspaceId, `page_${String(index)}`, new Date(base + index * 1000))),
      )

      const first = readRecord(await (await h.client.send('GET', '/v1/ai/runs?limit=2', { cookie })).json())
      const firstIds = (first.data as readonly { readonly id: string }[]).map((run) => run.id)
      expect(firstIds).toEqual(['ai_page_2', 'ai_page_1'])
      expect(typeof first.next_cursor).toBe('string')

      const second = readRecord(
        await (
          await h.client.send('GET', `/v1/ai/runs?limit=2&cursor=${encodeURIComponent(String(first.next_cursor))}`, {
            cookie,
          })
        ).json(),
      )
      expect((second.data as readonly { readonly id: string }[]).map((run) => run.id)).toEqual(['ai_page_0'])
      expect(second.next_cursor).toBeNull()
    })

    it('names each run target and the records its operations cite, but not the workspace', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h)
      const company = readRecord(
        await (await h.client.send('POST', '/v1/companies', { body: { name: 'Acme' }, cookie })).json(),
      )
      const note = readRecord(
        await (
          await h.client.send('POST', '/v1/notes', {
            body: { target_type: 'company', target_id: company.id, body: 'Acme sells to banks.' },
            cookie,
          })
        ).json(),
      )
      const base = Date.now() - 60_000
      await h.app.services.db.insert(aiRuns).values([
        {
          ...settledRow(workspaceId, 'named_company', new Date(base)),
          taskId: 'company.account_brief',
          targetType: 'company',
          targetId: String(company.id),
          operations: [{ kind: 'append_note', status: 'applied', detail: `Created note ${String(note.id)}` }],
        },
        {
          ...settledRow(workspaceId, 'named_workspace', new Date(base + 1000)),
          taskId: 'person_intake.research',
          targetType: 'workspace',
          targetId: workspaceId,
        },
      ])

      const runs = readList(await (await h.client.send('GET', '/v1/ai/runs', { cookie })).json())
      expect(runs.map((run) => [run.id, run.target_name])).toEqual([
        ['ai_named_workspace', null],
        ['ai_named_company', 'Acme'],
      ])
      expect(runs[1]?.operations).toEqual([
        {
          kind: 'append_note',
          status: 'applied',
          detail: `Created note ${String(note.id)}`,
          references: [
            {
              target_type: 'note',
              target_id: note.id,
              name: 'Acme sells to banks.',
              parent_type: 'company',
              parent_id: company.id,
            },
          ],
        },
      ])

      const single = readRecord(await (await h.client.send('GET', '/v1/ai/runs/ai_named_company', { cookie })).json())
      expect(single.target_name).toBe('Acme')
    })

    it('trims settled runs past the workspace run log limit', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      await h.app.services.db.update(aiSettings).set({ runLogLimit: 3 }).where(eq(aiSettings.workspaceId, workspaceId))
      const thisMonth = new Date(monthWindowStart(new Date()).getTime() + 1000)
      await h.app.services.db
        .insert(aiRuns)
        .values([
          settledRow(workspaceId, 'current', thisMonth),
          settledRow(workspaceId, 'old_1', daysAgo(40)),
          settledRow(workspaceId, 'old_2', daysAgo(41)),
          settledRow(workspaceId, 'old_3', daysAgo(42)),
        ])

      h.provider.queue(endTurn(proposal({ summary: 'ok' }), { inputTokens: 1, outputTokens: 1 }))
      await deliver(h, dispatchBody({ runId: 'run_after_trim', workspaceId }))
      await settled(h, 'run_after_trim')

      expect(await runIds(h, workspaceId)).toEqual(['ai_current', 'ai_old_1', 'ai_old_2', 'new'])
    })

    it('never trims a run from the current month, so the monthly count holds', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      await h.app.services.db.update(aiSettings).set({ runLogLimit: 1 }).where(eq(aiSettings.workspaceId, workspaceId))
      const monthStart = monthWindowStart(new Date()).getTime()
      await h.app.services.db
        .insert(aiRuns)
        .values([
          settledRow(workspaceId, 'current_1', new Date(monthStart + 1000)),
          settledRow(workspaceId, 'current_2', new Date(monthStart + 2000)),
          settledRow(workspaceId, 'old_1', daysAgo(40)),
        ])

      h.provider.queue(endTurn(proposal({ summary: 'ok' }), { inputTokens: 1, outputTokens: 1 }))
      await deliver(h, dispatchBody({ runId: 'run_after_trim', workspaceId }))
      await settled(h, 'run_after_trim')

      expect(await runIds(h, workspaceId)).toEqual(['ai_current_1', 'ai_current_2', 'new'])
    })

    it('reseals a dispatch secret left by the HTTP version, and is idempotent', async () => {
      const { workspaceId } = await enabledWorkspace(h)
      await h.app.services.db
        .update(aiSettings)
        .set({ dispatchSecretEncrypted: cipher.seal('Bearer aidsp_old') })
        .where(eq(aiSettings.workspaceId, workspaceId))

      const NEXT_KEY = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='
      const rotating = createSecretCipher({
        SECRET_ENCRYPTION_KEY: NEXT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: TEST_SECRET_ENCRYPTION_KEY,
      })

      const first = await resealAiSecrets(h.app.services.db, rotating)
      expect(first).toMatchObject({ examined: 1, resealed: 1, unreadable: 0 })
      expect(first.columns[0]?.label).toBe('ai_settings.dispatch_secret_encrypted')

      const second = await resealAiSecrets(h.app.services.db, rotating)
      expect(second).toMatchObject({ examined: 1, resealed: 0, unreadable: 0 })

      const [row] = await h.app.services.db.select().from(aiSettings)
      expect(createSecretCipher({ SECRET_ENCRYPTION_KEY: NEXT_KEY }).open(row!.dispatchSecretEncrypted!)).toBe('Bearer aidsp_old')
    })
  })

  describe('deployment key mode without a key', () => {
    let h: Harness

    afterAll(async () => {
      await h.close()
    })

    beforeAll(async () => {
      h = await buildHarness(database, { keyMode: 'deployment' })
    })

    beforeEach(async () => {
      await database.truncateAll()
    })

    it('boots and reports configured=false', async () => {
      const owner = await h.client.owner('unconfigured@example.com')
      const body = readRecord(await (await h.client.send('GET', '/v1/ai/settings', { cookie: owner.cookie })).json())

      expect(body.configured).toBe(false)
      expect(body.enabled).toBe(false)
    })

    it('refuses enable with a 409 that names the missing env vars', async () => {
      const owner = await h.client.owner('nokey-admin@example.com')
      const response = await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie })

      expect(response.status).toBe(409)
      expect(readString(readRecord(await response.json()).error, 'message')).toContain('AI_API_KEY')
    })
  })

  describe('workspace key mode', () => {
    let h: Harness

    afterAll(async () => {
      await h.close()
    })

    beforeAll(async () => {
      h = await buildHarness(database, { keyMode: 'workspace' })
    })

    beforeEach(async () => {
      await database.truncateAll()
      h.provider.reset()
      h.toolLog.length = 0
    })

    it('offers a custom provider by default, and names its Run menu agent for it', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h, 'custom@example.com', {
        provider: 'openai',
        api_key: 'sk-custom-key-0001',
      })

      const view = readRecord(await (await h.client.send('GET', '/v1/ai/settings', { cookie })).json())
      expect(view.service).toBe('custom')

      // A row an older version named "Kelpie AI" takes the service's name on the next save.
      await h.app.services.db
        .update(agentRegistrations)
        .set({ name: 'Kelpie AI' })
        .where(eq(agentRegistrations.workspaceId, workspaceId))
      expect((await h.client.send('POST', '/v1/ai/settings', { cookie, body: {} })).status).toBe(200)

      const names = await h.app.services.db
        .select({ name: agentRegistrations.name })
        .from(agentRegistrations)
        .where(and(eq(agentRegistrations.workspaceId, workspaceId), eq(agentRegistrations.managedBy, 'ai')))
      expect(names).toEqual([{ name: 'Custom provider' }])
    })

    it('refuses enable until the workspace chooses a provider and enters a key', async () => {
      const owner = await h.client.owner()
      const view = readRecord(await (await h.client.send('GET', '/v1/ai/settings', { cookie: owner.cookie })).json())
      expect(view).toMatchObject({ key_mode: 'workspace', configured: false, provider: null, key_source: null })

      const response = await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie })
      expect(response.status).toBe(409)
      expect(readString(readRecord(await response.json()).error, 'message')).toContain('enter an API key')

      const keyless = await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie, body: { provider: 'anthropic' } })
      expect(keyless.status).toBe(409)

      const rows = await h.app.services.db.select().from(aiSettings)
      expect(rows).toHaveLength(0)
    })

    it('seals the key, shows only its last four characters, and runs with it', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h, 'byo@example.com', {
        provider: 'anthropic',
        api_key: 'sk-ant-workspace-key-WXYZ',
      })

      const [stored] = await h.app.services.db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workspaceId))
      expect(stored?.provider).toBe('anthropic')
      expect(stored?.apiKeyEncrypted).not.toContain('sk-ant')
      expect(cipher.open(stored!.apiKeyEncrypted!)).toBe('sk-ant-workspace-key-WXYZ')

      const settingsResponse = await h.client.send('GET', '/v1/ai/settings', { cookie })
      const text = await settingsResponse.text()
      expect(text).not.toContain('sk-ant-workspace-key')
      expect(JSON.parse(text)).toMatchObject({
        key_mode: 'workspace',
        configured: true,
        enabled: true,
        provider: 'anthropic',
        model: 'claude-opus-5',
        key_source: 'workspace',
        key_hint: 'WXYZ',
        monthly_limit: null,
      })

      h.provider.queue(endTurn(proposal({ summary: 'byo run' })))
      await deliver(h, dispatchBody({ runId: 'run_byo', workspaceId }))
      const row = await settled(h, 'run_byo')

      expect(row.status).toBe('succeeded')
      expect(row.model).toBe('claude-opus-5')
      expect(h.provider.keys).toEqual(['sk-ant-workspace-key-WXYZ'])
      expect(h.provider.requests[0]?.model).toBe('claude-opus-5')
      expect(h.app.logLines.some((line) => line.includes('sk-ant-workspace-key'))).toBe(false)
    })

    it('keeps the stored key when only the model changes, and drops it when the provider changes', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h, 'switch@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-workspace-0001',
      })

      const renamed = await h.client.send('POST', '/v1/ai/settings', { cookie, body: { model: 'gpt-5' } })
      expect(renamed.status).toBe(200)
      expect(readRecord(await renamed.json())).toMatchObject({ model: 'gpt-5', key_source: 'workspace' })

      // A key for one provider means nothing to another.
      const switched = await h.client.send('POST', '/v1/ai/settings', { cookie, body: { provider: 'anthropic' } })
      expect(switched.status).toBe(409)

      const [unchanged] = await h.app.services.db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workspaceId))
      expect(unchanged?.provider).toBe('openai')
      expect(unchanged?.model).toBe('gpt-5')

      const withKey = await h.client.send('POST', '/v1/ai/settings', {
        cookie,
        body: { provider: 'anthropic', api_key: 'sk-ant-second-key-0002' },
      })
      expect(withKey.status).toBe(200)
      // The OpenAI model does not carry over.
      expect(readRecord(await withKey.json())).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' })
    })

    it('shows the provider error to the workspace: the key is theirs to fix', async () => {
      const { workspaceId } = await enabledWorkspace(h, 'badkey@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-wrong-0000',
      })
      h.provider.queue({
        stopReason: 'failed',
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        failure: { code: 'invalid_api_key', message: 'The OpenAI API key was rejected. Check the key in AI settings.' },
      })

      await deliver(h, dispatchBody({ runId: 'run_badkey', workspaceId }))
      const row = await settled(h, 'run_badkey')

      expect(row.status).toBe('failed')
      expect(row.failureReason).toBe('The OpenAI API key was rejected. Check the key in AI settings.')
    })

    it('refuses a dispatch once the key is gone, with a reason the run log can show', async () => {
      const { workspaceId } = await enabledWorkspace(h, 'gone@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-workspace-0003',
      })
      await h.app.services.db.update(aiSettings).set({ apiKeyEncrypted: null }).where(eq(aiSettings.workspaceId, workspaceId))

      const response = await deliver(h, dispatchBody({ runId: 'run_nokey', workspaceId }))
      expect(response.status).toBe(409)
      expect(await fetchRun(h, 'run_nokey')).toBeUndefined()
    })

    it('refuses an unknown provider and a misspelt field', async () => {
      const owner = await h.client.owner()

      expect(
        (await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie, body: { provider: 'gemini', api_key: 'x-000000000000' } })).status,
      ).toBe(422)
      expect(
        (await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie, body: { provider: 'openai', apikey: 'x-000000000000' } })).status,
      ).toBe(422)
    })

    it('needs the admin role to enable or disable', async () => {
      const owner = await h.client.owner()
      const memberCookie = await h.client.signUp('member@example.com')
      await h.client.send('POST', `/v1/workspaces/${owner.workspaceId}/invites`, {
        body: { email: 'member@example.com', role: 'member' },
        cookie: owner.cookie,
      })
      const token = /token=([^\s]+)/u.exec(h.app.services.sentEmails.at(-1)?.body ?? '')?.[1] ?? ''
      expect((await h.client.send('POST', '/v1/invites/accept', { body: { token }, cookie: memberCookie })).status).toBeLessThan(300)
      const member = { cookie: memberCookie }

      // A member can read the settings, so the session resolves to the workspace.
      expect((await h.client.send('GET', '/v1/ai/settings', { cookie: member.cookie })).status).toBe(200)
      expect(
        (await h.client.send('POST', '/v1/ai/settings', { cookie: member.cookie, body: { provider: 'openai', api_key: 'sk-000000000000' } })).status,
      ).toBe(403)
      expect((await h.client.send('DELETE', '/v1/ai/settings', { cookie: member.cookie })).status).toBe(403)
    })

    it('forgets the key on disable', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h, 'forget@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-workspace-0004',
      })

      expect((await h.client.send('DELETE', '/v1/ai/settings', { cookie })).status).toBeLessThan(300)

      const rows = await h.app.services.db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workspaceId))
      expect(rows).toHaveLength(0)
    })

    it('reseals the workspace key', async () => {
      await enabledWorkspace(h, 'reseal@example.com', { provider: 'openai', api_key: 'sk-openai-workspace-0005' })

      const NEXT_KEY = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='
      const rotating = createSecretCipher({
        SECRET_ENCRYPTION_KEY: NEXT_KEY,
        SECRET_ENCRYPTION_KEY_PREVIOUS: TEST_SECRET_ENCRYPTION_KEY,
      })

      const outcome = await resealAiSecrets(h.app.services.db, rotating)
      // One sealed value: the key. There is no dispatch secret any more.
      expect(outcome).toMatchObject({ examined: 1, resealed: 1, unreadable: 0 })
      expect(outcome.columns.map((column) => column.label)).toEqual([
        'ai_settings.dispatch_secret_encrypted',
        'ai_settings.api_key_encrypted',
      ])

      const [row] = await h.app.services.db.select().from(aiSettings)
      expect(createSecretCipher({ SECRET_ENCRYPTION_KEY: NEXT_KEY }).open(row!.apiKeyEncrypted!)).toBe(
        'sk-openai-workspace-0005',
      )
    })
  })

  describe('workspace key mode with an environment fallback', () => {
    let h: Harness

    afterAll(async () => {
      await h.close()
    })

    beforeAll(async () => {
      h = await buildHarness(database, {
        keyMode: 'workspace',
        environment: { AI_PROVIDER: 'openai', AI_API_KEY: 'sk-fallback-key-0009', AI_MODEL: 'gpt-5' },
      })
    })

    beforeEach(async () => {
      await database.truncateAll()
      h.provider.reset()
    })

    it('enables with an empty body on the deployment key, and never hints at it', async () => {
      const { cookie } = await enabledWorkspace(h)
      const view = readRecord(await (await h.client.send('GET', '/v1/ai/settings', { cookie })).json())

      expect(view).toMatchObject({
        configured: true,
        provider: 'openai',
        model: 'gpt-5',
        key_source: 'environment',
        key_hint: null,
      })
    })

    it('prefers the workspace key, and returns to the fallback when it is cleared', async () => {
      const { cookie } = await enabledWorkspace(h, 'prefers@example.com', { api_key: 'sk-openai-own-key-0010' })

      const own = readRecord(await (await h.client.send('GET', '/v1/ai/settings', { cookie })).json())
      expect(own).toMatchObject({ key_source: 'workspace', key_hint: '0010', model: 'gpt-5' })

      const cleared = await h.client.send('POST', '/v1/ai/settings', { cookie, body: { api_key: null } })
      expect(readRecord(await cleared.json())).toMatchObject({ key_source: 'environment', key_hint: null })
    })

    it('does not lend the fallback key to another provider', async () => {
      const owner = await h.client.owner()
      const response = await h.client.send('POST', '/v1/ai/settings', { cookie: owner.cookie, body: { provider: 'anthropic' } })

      expect(response.status).toBe(409)
    })
  })

  describe('end to end through core dispatch and the real tools', () => {
    let h: Harness

    afterAll(async () => {
      await h.close()
    })

    /** Every HTTP dispatch core attempted. The Kelpie AI row must never be one. */
    const httpDispatches: string[] = []

    beforeAll(async () => {
      const send: SendDispatch = (request) => {
        httpDispatches.push(request.url)
        return Promise.resolve({ delivered: false, status: 404, reason: 'agent endpoint answered 404' })
      }

      h = await buildHarness(database, { keyMode: 'workspace', realTools: true, send })
    })

    beforeEach(async () => {
      await database.truncateAll()
      h.provider.reset()
      httpDispatches.length = 0
    })

    it('runs a task from the Run dialog and writes a real note on a real person', async () => {
      const { cookie } = await enabledWorkspace(h, 'e2e@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-e2e-key-0011',
      })

      const person = await h.client.send('POST', '/v1/people', { cookie, body: { name: 'Grace Hopper' } })
      expect(person.status).toBe(201)
      const personId = readString(await person.json(), 'id')

      const agents = readList(await (await h.client.send('GET', '/v1/agents', { cookie })).json())
      const kelpieAi = agents.find((agent) => agent.name === 'Custom provider')
      expect(kelpieAi).toBeDefined()

      h.provider.queue(
        endTurn(
          proposal({
            summary: 'Added a note about Grace.',
            operations: [{ kind: 'append_note', body: 'Invented the first compiler.', pinned: true }],
          }),
        ),
      )

      const run = await h.client.send('POST', '/v1/agent-tasks/person.enrich/run', {
        cookie,
        body: { target_type: 'person', target_id: personId, agent_id: kelpieAi?.id },
      })
      expect(run.status).toBe(201)

      const notes = await until(async () => {
        const listed = readList(
          await (await h.client.send('GET', `/v1/notes?target_type=person&target_id=${personId}`, { cookie })).json(),
        )
        return listed.length > 0 ? listed : undefined
      })

      expect(notes[0]).toMatchObject({ body: 'Invented the first compiler.', pinned: true })
      // The context pack was read with the real people tool.
      expect(h.provider.requests[0]?.messages[0]?.text ?? '').toContain('Grace Hopper')
      // Core handed the run to the module directly.
      expect(httpDispatches).toEqual([])
    })

    it('dispatches in-process even when the row still stores an old loopback URL', async () => {
      const { cookie, workspaceId } = await enabledWorkspace(h, 'legacy-row@example.com', {
        provider: 'openai',
        api_key: 'sk-openai-e2e-key-0012',
      })
      // What the HTTP version wrote, pointing at a port another app holds.
      await h.app.services.db
        .update(agentRegistrations)
        .set({ endpoint: 'http://localhost:5173/v1/public/ai/dispatch' })
        .where(eq(agentRegistrations.workspaceId, workspaceId))

      const person = await h.client.send('POST', '/v1/people', { cookie, body: { name: 'Ada Lovelace' } })
      const personId = readString(await person.json(), 'id')
      const agents = readList(await (await h.client.send('GET', '/v1/agents', { cookie })).json())
      const agentId = agents.find((agent) => agent.name === 'Custom provider')?.id

      h.provider.queue(endTurn(proposal({ summary: 'Nothing to change.' })))
      const run = await h.client.send('POST', '/v1/agent-tasks/person.enrich/run', {
        cookie,
        body: { target_type: 'person', target_id: personId, agent_id: agentId },
      })
      const agentRunId = readString(await run.json(), 'id')

      const aiRun = await settled(h, agentRunId)
      expect(aiRun.status).toBe('succeeded')
      expect(httpDispatches).toEqual([])
    })
  })
})

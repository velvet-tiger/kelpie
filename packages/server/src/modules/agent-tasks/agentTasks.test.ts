import {
  agentRunSchema,
  agentTaskDefinitionSchema,
  registeredAgentSchema,
  resolvedAgentTaskSchema,
} from '@kelpie/schemas'
import type { KelpieEvent } from '@kelpie/schemas'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCaptureTransport, createLogger } from '../../lib/logger.ts'
import { createSecretCipher } from '../../lib/secrets.ts'
import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT, TEST_SECRET_ENCRYPTION_KEY } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { createDispatchEngine } from './dispatch.ts'
import type { DispatchEngine, DispatchOutcome, DispatchRequest, SendDispatch } from './dispatch.ts'
import type { AgentRunSettledData } from './events.ts'
import { createAgentTasksModule } from './index.ts'
import { findAgent, insertRun } from './repository.ts'
import type { AgentRecord, RunRecord } from './repository.ts'
import { agentRegistrations, agentRuns } from './schema.ts'
import type { ResolvedTaskView } from './wire.ts'

/**
 * `/v1/agent-tasks`, `/v1/agent-runs` and `/v1/agents`, against real Postgres.
 *
 * The outbound port is injected, so the suite asserts exactly what a registered
 * agent would have received without a network call. Everything else — the
 * catalog, resolve's reads, the run lifecycle — runs against the same rows
 * production would write.
 */

const connectionString = testDatabaseUrl(process.env)

const DELIVERED: DispatchOutcome = { delivered: true, status: 200, reason: null }


describe.skipIf(connectionString === undefined)('agent tasks', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

  /** What the fake sender was asked to send, and what it answers with. */
  let sent: DispatchRequest[]
  let outcome: DispatchOutcome
  /** When set, the sender answers with this instead, so a test can hold a run at `running`. */
  let pending: Promise<DispatchOutcome> | undefined

  const send: SendDispatch = (request) => {
    sent.push(request)

    return pending ?? Promise.resolve(outcome)
  }

  /**
   * A module that manages agent rows and receives their dispatches
   * in-process, the way the optional `ai` module does.
   */
  let received: Readonly<Record<string, unknown>>[]

  /** Every `agent_tasks.run.settled` the bus published, whole envelope. */
  let settledEvents: KelpieEvent<'agent_tasks.run.settled', AgentRunSettledData>[]

  const probeModule: KelpieModule = {
    id: 'probe',
    register(context) {
      context.agentDispatch.provide((payload) => {
        received.push(payload)
        return Promise.resolve({ delivered: true, status: 202, reason: null })
      })
      return Promise.resolve()
    },
  }

  /** A managing module whose dispatcher throws, to reach the engine's own boundary. */
  const throwerModule: KelpieModule = {
    id: 'thrower',
    register(context) {
      context.agentDispatch.provide(() => Promise.reject(new Error('the dispatcher threw')))
      return Promise.resolve()
    },
  }

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
    sent = []
    received = []
    settledEvents = []
    outcome = DELIVERED
    pending = undefined

    harness = await createTestApp({
      // The one module swapped for a configured copy. Order is resolved from
      // `requires`, so appending it is the same registration order as core's.
      modules: [
        ...coreModules.filter((module) => module.id !== 'agent-tasks'),
        createAgentTasksModule(coreMigrationsDirectory, { send }),
        probeModule,
        throwerModule,
      ],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
    })
    harness.services.events.subscribe('agent_tasks.run.settled', (event) => {
      settledEvents.push(event)
    })
    client = createTestClient(harness.app, harness.services.db)
    acme = await client.owner()
  })

  async function createRecord(
    path: string,
    body: Record<string, unknown>,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', path, { body, cookie })

    expect(response.status).toBe(201)

    return readRecord(await response.json())
  }

  async function createCompany(name = 'Brightline Health'): Promise<string> {
    return readString(await createRecord('/v1/companies', { name }), 'id')
  }

  async function createAgent(
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return createRecord('/v1/agents', {
      name: 'Local Claude',
      endpoint: 'https://agents.example.com/kelpie/run',
      ...body,
    })
  }

  async function resolveTask(
    taskId: string,
    targetType: string,
    targetId: string,
    cookie = acme.cookie,
  ): Promise<Record<string, unknown>> {
    const response = await client.send('POST', `/v1/agent-tasks/${taskId}/resolve`, {
      body: { target_type: targetType, target_id: targetId },
      cookie,
    })

    expect(response.status).toBe(200)

    return readRecord(await response.json())
  }

  /** The dispatch is detached from the request, so the suite polls the run. */
  async function settledRun(id: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await client.send('GET', `/v1/agent-runs/${id}`, { cookie: acme.cookie })

      expect(response.status).toBe(200)

      const run = readRecord(await response.json())

      if (run.status === 'succeeded' || run.status === 'failed') {
        return run
      }

      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    throw new Error(`Run ${id} never settled`)
  }

  /** Starts `company.enrich` on a new company and answers the queued run's id. */
  async function startRun(agentId: string): Promise<string> {
    const companyId = await createCompany()
    const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
      body: { target_type: 'company', target_id: companyId, agent_id: agentId },
      cookie: acme.cookie,
    })

    expect(response.status).toBe(201)

    return readString(readRecord(await response.json()), 'id')
  }

  /**
   * The run row is written before the event is published, so a poll that sees
   * the final status can still be ahead of the bus. Waits for the event, then
   * drains so that a second, wrong publication would be counted too.
   */
  async function settledEventsFor(runId: string): Promise<AgentRunSettledData[]> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (settledEvents.some((event) => event.data.runId === runId)) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    await harness.services.events.drain()

    return settledEvents.filter((event) => event.data.runId === runId).map((event) => event.data)
  }

  /**
   * A dispatch engine of the suite's own, on the harness's database and event
   * bus, so a test can await a dispatch rather than poll for it.
   */
  function directEngine(sendDispatch: SendDispatch): { engine: DispatchEngine; logLines: string[] } {
    const logLines: string[] = []

    const engine = createDispatchEngine({
      db: harness.services.db,
      transaction: harness.services.transaction,
      now: () => new Date(),
      cipher: createSecretCipher({ SECRET_ENCRYPTION_KEY: TEST_SECRET_ENCRYPTION_KEY }),
      send: sendDispatch,
      findManagedDispatcher: () => undefined,
      log: createLogger({ level: 'debug', transports: [createCaptureTransport((line) => logLines.push(line))] }),
    })

    return { engine, logLines }
  }

  interface DirectDispatch {
    readonly runId: string
    readonly run: RunRecord
    readonly agent: AgentRecord
    readonly resolved: ResolvedTaskView
    readonly logLines: string[]
    readonly dispatch: () => Promise<void>
  }

  /** A queued run on a new agent, ready for a direct engine to dispatch. */
  async function directDispatch(sendDispatch: SendDispatch): Promise<DirectDispatch> {
    const companyId = await createCompany()
    const agentId = readString(await createAgent(), 'id')
    const agent = await findAgent(database.db, acme.workspaceId, agentId)

    if (agent === undefined) {
      throw new Error(`Agent ${agentId} was not stored`)
    }

    const run = await insertRun(database.db, {
      id: harness.services.createId('agentRun'),
      workspaceId: acme.workspaceId,
      agentId,
      taskId: 'company.enrich',
      targetType: 'company',
      targetId: companyId,
      status: 'queued',
    })
    const resolved: ResolvedTaskView = {
      taskId: 'company.enrich',
      targetType: 'company',
      targetId: companyId,
      prompt: 'Enrich the company.',
      basePrompt: 'Enrich the company.',
      context: {
        targetLabel: 'Brightline Health',
        deepLink: `/companies/${companyId}`,
        handbookSlugs: [],
        pinnedNoteIds: [],
        openPlanIds: [],
        openDecisionIds: [],
        related: {},
      },
    }
    const { engine, logLines } = directEngine(sendDispatch)

    return {
      runId: run.id,
      run,
      agent,
      resolved,
      logLines,
      dispatch: () => engine.dispatch(run, agent, resolved),
    }
  }

  /** Invites an address as a plain member and accepts as a fresh account. */
  async function addMember(email: string, role: 'admin' | 'member'): Promise<string> {
    const invited = await client.send('POST', `/v1/workspaces/${acme.workspaceId}/invites`, {
      body: { email, role },
      cookie: acme.cookie,
    })
    expect(invited.status).toBe(201)

    const body = harness.services.sentEmails.at(-1)?.body ?? ''
    const token = /token=(?<token>[\w-]+)/u.exec(body)?.groups?.token

    if (token === undefined) {
      throw new Error(`No invite token in the sent email: ${body}`)
    }

    const cookie = await client.signUp(email)
    const accepted = await client.send('POST', '/v1/invites/accept', { body: { token }, cookie })
    expect(accepted.status).toBe(200)

    return cookie
  }

  describe('GET /v1/agent-tasks', () => {
    it('answers the whole catalog with no cursor', async () => {
      const response = await client.send('GET', '/v1/agent-tasks', { cookie: acme.cookie })

      expect(response.status).toBe(200)

      const payload = (await response.json()) as Record<string, unknown>
      const tasks = readList(payload).map((task) => agentTaskDefinitionSchema.parse(task))

      expect(tasks).toHaveLength(79)
      expect(payload.next_cursor).toBeNull()
    })

    it('narrows to one target type', async () => {
      const response = await client.send('GET', '/v1/agent-tasks?target_type=role', {
        cookie: acme.cookie,
      })
      const tasks = readList(await response.json())

      expect(tasks.map((task) => task.id)).toEqual(['role.compare_shortlist'])
    })

    it('refuses a target type it does not have', async () => {
      const response = await client.send('GET', '/v1/agent-tasks?target_type=invoice', {
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('needs credentials', async () => {
      expect((await client.send('GET', '/v1/agent-tasks')).status).toBe(401)
    })
  })

  describe('POST /v1/agent-tasks/:taskId/resolve', () => {
    it('assembles the prompt and context for a company', async () => {
      const companyId = await createCompany()

      await createRecord('/v1/notes', {
        target_type: 'company',
        target_id: companyId,
        body: 'Champion confirmed budget',
        pinned: true,
      })
      await createRecord('/v1/notes', {
        target_type: 'company',
        target_id: companyId,
        body: 'Unpinned noise',
      })
      const decision = await createRecord('/v1/decisions', {
        target_type: 'company',
        target_id: companyId,
        body: 'We will not discount below 20%',
      })

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('company.score_icp', 'company', companyId),
      )

      expect(resolved.taskId).toBe('company.score_icp')
      expect(resolved.targetId).toBe(companyId)
      expect(resolved.context.targetLabel).toBe('Brightline Health')
      expect(resolved.context.deepLink).toBe(`/companies/${companyId}`)
      // The starter handbook is seeded with the workspace, so both slugs exist.
      expect(resolved.context.handbookSlugs).toEqual(['ideal-customer-profile', 'agent-faq'])
      expect(resolved.context.pinnedNoteIds).toHaveLength(1)
      expect(resolved.context.openDecisionIds).toEqual([readString(decision, 'id')])
      expect(resolved.prompt).toContain('# Agent task: Score ICP fit')
      expect(resolved.prompt).toContain(`- **UI:** /companies/${companyId}`)
      expect(resolved.prompt).toContain('- Respect open Decisions; do not contradict them.')
    })

    it('collects open Plan items and related people on a deal', async () => {
      const companyId = await createCompany()
      const person = await createRecord('/v1/people', {
        name: 'Ada Lovelace',
        email: 'ada2@example.com',
      })
      const stages = readList(
        await (
          await client.send('GET', '/v1/pipeline_stages?kind=deal', { cookie: acme.cookie })
        ).json(),
      )
      const stageId = readString(readRecord(stages[0]), 'id')
      const deal = await createRecord('/v1/deals', {
        name: 'Brightline rollout',
        company_id: companyId,
        stage_id: stageId,
        person_ids: [readString(person, 'id')],
      })
      const dealId = readString(deal, 'id')

      const openPlan = await createRecord('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date: '2026-09-01',
        title: 'Send proposal',
      })
      await createRecord('/v1/plan_items', {
        target_type: 'deal',
        target_id: dealId,
        date: '2026-08-01',
        title: 'Already done',
        status: 'done',
      })

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('deal.propose_plan', 'deal', dealId),
      )

      expect(resolved.context.openPlanIds).toEqual([readString(openPlan, 'id')])
      expect(resolved.context.related.company_ids).toEqual([companyId])
      expect(resolved.context.related.person_ids).toEqual([readString(person, 'id')])
      expect(resolved.prompt).toContain('## Related ids')
    })

    it('names a candidate by person and role', async () => {
      const person = await createRecord('/v1/people', {
        name: 'Grace Hopper',
        email: 'grace@example.com',
      })
      const role = await createRecord('/v1/roles', { title: 'Founding Engineer' })
      const candidate = await createRecord('/v1/candidates', {
        role_id: readString(role, 'id'),
        person_id: readString(person, 'id'),
        status: 'in_process',
      })

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('candidate.score', 'candidate', readString(candidate, 'id')),
      )

      expect(resolved.context.targetLabel).toBe('Grace Hopper · Founding Engineer')
      expect(resolved.context.deepLink).toBe(`/hiring/${readString(role, 'id')}`)
      expect(resolved.context.related.person_ids).toEqual([readString(person, 'id')])
      expect(resolved.context.related.role_ids).toEqual([readString(role, 'id')])
    })

    it('resolves a handbook page by id', async () => {
      const pages = readList(
        await (
          await client.send('GET', '/v1/handbook_pages?slug=agent-faq', { cookie: acme.cookie })
        ).json(),
      )
      const pageId = readString(readRecord(pages[0]), 'id')

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('handbook.draft_update', 'handbook', pageId),
      )

      expect(resolved.context.deepLink).toBe(`/handbook/${pageId}`)
    })

    it('sweeps the workspace for empty fields, with exact totals', async () => {
      const companyId = await createCompany('Summaryless Co')

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('workspace.empty_field_sweep', 'workspace', acme.workspaceId),
      )

      expect(resolved.context.deepLink).toBe('/dashboard')
      expect(resolved.prompt).toContain('## Workspace signals')
      expect(resolved.prompt).toContain(`- Companies missing a summary: 1 total — ${companyId}`)
      expect(resolved.prompt).toContain(`- Companies missing an ICP fit: 1 total — ${companyId}`)
      expect(resolved.prompt).toContain('- People missing a summary: none')
      expect(resolved.prompt).toContain('1. Load the workspace dashboard: `GET /v1/dashboard`')
    })

    it('flags open pipeline records with nothing planned', async () => {
      const companyId = await createCompany()
      const stages = readList(
        await (
          await client.send('GET', '/v1/pipeline_stages?kind=deal', { cookie: acme.cookie })
        ).json(),
      )
      const dealId = readString(
        await createRecord('/v1/deals', {
          name: 'Unplanned deal',
          company_id: companyId,
          stage_id: readString(readRecord(stages[0]), 'id'),
        }),
        'id',
      )

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('workspace.pipeline_review', 'workspace', acme.workspaceId),
      )

      expect(resolved.prompt).toContain(`- Open deals with no open Plan item: 1 total — ${dealId}`)
    })

    it('refuses the wrong workspace id as the workspace target', async () => {
      const response = await client.send('POST', '/v1/agent-tasks/workspace.daily_brief/resolve', {
        body: { target_type: 'workspace', target_id: 'ws_somebody_else' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('answers 404 for a task that does not exist', async () => {
      const response = await client.send('POST', '/v1/agent-tasks/company.invent/resolve', {
        body: { target_type: 'company', target_id: 'com_x' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
    })

    it('answers 422 for a task aimed at the wrong target type', async () => {
      const companyId = await createCompany()
      const response = await client.send('POST', '/v1/agent-tasks/person.enrich/resolve', {
        body: { target_type: 'company', target_id: companyId },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('answers 404 for a target in another workspace', async () => {
      const companyId = await createCompany()
      const stranger = await client.owner('rival@example.com')
      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/resolve', {
        body: { target_type: 'company', target_id: companyId },
        cookie: stranger.cookie,
      })

      expect(response.status).toBe(404)
    })
  })

  describe('/v1/agents', () => {
    it('registers an agent, never echoing the auth header', async () => {
      const created = await createAgent({ auth_header: 'Bearer super-secret' })
      const agent = registeredAgentSchema.parse(created)

      expect(agent.hasAuthHeader).toBe(true)
      expect(agent.lastRunAt).toBeNull()
      expect(JSON.stringify(created)).not.toContain('super-secret')
    })

    it('reports has_auth_header false when none was given', async () => {
      expect(registeredAgentSchema.parse(await createAgent()).hasAuthHeader).toBe(false)
    })

    it('lets a member read the list the Run dialog needs, but not write it', async () => {
      await createAgent()
      const member = await addMember('member@example.com', 'member')

      const list = await client.send('GET', '/v1/agents', { cookie: member })

      expect(list.status).toBe(200)
      expect(readList(await list.json())).toHaveLength(1)

      const write = await client.send('POST', '/v1/agents', {
        body: { name: 'Rogue', endpoint: 'https://rogue.example.com/run' },
        cookie: member,
      })

      expect(write.status).toBe(403)
    })

    it('updates, clears the header, and deletes', async () => {
      const id = readString(await createAgent({ auth_header: 'Bearer one' }), 'id')

      const renamed = await client.send('PATCH', `/v1/agents/${id}`, {
        body: { name: 'Renamed', auth_header: null },
        cookie: acme.cookie,
      })

      expect(renamed.status).toBe(200)

      const agent = registeredAgentSchema.parse(readRecord(await renamed.json()))

      expect(agent.name).toBe('Renamed')
      expect(agent.hasAuthHeader).toBe(false)

      const removed = await client.send('DELETE', `/v1/agents/${id}`, { cookie: acme.cookie })

      expect(removed.status).toBe(204)
      expect((await client.send('GET', `/v1/agents/${id}`, { cookie: acme.cookie })).status).toBe(
        404,
      )
    })

    it('refuses to change or remove an agent a module manages', async () => {
      const id = readString(await createAgent(), 'id')

      // No route sets these columns; a module writes them directly.
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'ai', settingsPath: '/admin/ai' })
        .where(eq(agentRegistrations.id, id))

      const read = await client.send('GET', `/v1/agents/${id}`, { cookie: acme.cookie })
      const agent = registeredAgentSchema.parse(readRecord(await read.json()))

      expect(agent.managedBy).toBe('ai')
      expect(agent.settingsPath).toBe('/admin/ai')

      const renamed = await client.send('PATCH', `/v1/agents/${id}`, {
        body: { name: 'Renamed' },
        cookie: acme.cookie,
      })

      expect(renamed.status).toBe(409)

      const removed = await client.send('DELETE', `/v1/agents/${id}`, { cookie: acme.cookie })

      expect(removed.status).toBe(409)
      expect((await client.send('GET', `/v1/agents/${id}`, { cookie: acme.cookie })).status).toBe(
        200,
      )
    })

    it('reports an agent an admin registered as unmanaged', async () => {
      const agent = registeredAgentSchema.parse(await createAgent())

      expect(agent.managedBy).toBeNull()
      expect(agent.settingsPath).toBeNull()
    })

    it('refuses a managed_by field on create', async () => {
      const response = await client.send('POST', '/v1/agents', {
        body: { name: 'Sneaky', endpoint: 'https://agents.example.com/run', managed_by: 'ai' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)
    })

    it('refuses an endpoint with credentials in the URL', async () => {
      const response = await client.send('POST', '/v1/agents', {
        body: { name: 'Bad', endpoint: 'https://user:pass@example.com/run' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(422)

      const payload = (await response.json()) as {
        error?: { details?: { message?: string }[] }
      }

      expect(payload.error?.details?.[0]?.message).toContain('auth_header')
    })

    it('hides another workspace entirely', async () => {
      const id = readString(await createAgent(), 'id')
      const stranger = await client.owner('rival2@example.com')

      expect(
        (await client.send('GET', `/v1/agents/${id}`, { cookie: stranger.cookie })).status,
      ).toBe(404)
    })
  })

  describe('POST /v1/agent-tasks/:taskId/run', () => {
    it('creates a queued run and dispatches the resolved payload', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent({ auth_header: 'Bearer dispatch-key' }), 'id')

      const resolved = resolvedAgentTaskSchema.parse(
        await resolveTask('company.enrich', 'company', companyId),
      )

      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(201)

      const queuedWire = readRecord(await response.json())
      const queued = agentRunSchema.parse(queuedWire)

      expect(queued.status).toBe('queued')
      expect(queued.agentId).toBe(agentId)
      // The prompt holds personal data from the record: a run keeps metadata only.
      expect(queuedWire).not.toHaveProperty('prompt')

      const settled = agentRunSchema.parse(await settledRun(queued.id))

      expect(settled.status).toBe('succeeded')
      expect(settled.failureReason).toBeNull()

      expect(sent).toHaveLength(1)

      const request = sent[0]

      if (request === undefined) {
        throw new Error('Nothing was dispatched')
      }

      expect(request.url).toBe('https://agents.example.com/kelpie/run')
      expect(request.headers.authorization).toBe('Bearer dispatch-key')
      expect(request.headers['content-type']).toBe('application/json')

      const payload = JSON.parse(request.body) as Record<string, unknown>

      expect(payload.run_id).toBe(queued.id)
      expect(payload.workspace_id).toBe(acme.workspaceId)
      expect(payload.task_id).toBe('company.enrich')
      expect(payload.target_id).toBe(companyId)
      // Copy and Run must not drift: the dispatched prompt is the resolve prompt.
      expect(payload.prompt).toBe(resolved.prompt)
      expect(readRecord(payload.context).target_label).toBe('Brightline Health')

      const freshAgent = registeredAgentSchema.parse(
        readRecord(
          await (await client.send('GET', `/v1/agents/${agentId}`, { cookie: acme.cookie })).json(),
        ),
      )

      expect(freshAgent.lastRunAt).not.toBeNull()
    })

    it('sends no authorization header when none is stored', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')

      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const queued = agentRunSchema.parse(readRecord(await response.json()))

      await settledRun(queued.id)

      expect(sent[0]?.headers.authorization).toBeUndefined()
    })

    it('marks the run failed with the reason when the endpoint refuses', async () => {
      outcome = { delivered: false, status: 500, reason: 'agent endpoint answered 500' }

      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const queued = agentRunSchema.parse(readRecord(await response.json()))
      const settled = agentRunSchema.parse(await settledRun(queued.id))

      expect(settled.status).toBe('failed')
      expect(settled.failureReason).toBe('agent endpoint answered 500')
    })

    it('hands a managed agent’s run to its module in-process, never over HTTP', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent({ auth_header: 'Bearer unused' }), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'probe' })
        .where(eq(agentRegistrations.id, agentId))

      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const queued = agentRunSchema.parse(readRecord(await response.json()))
      const settled = agentRunSchema.parse(await settledRun(queued.id))

      expect(settled.status).toBe('succeeded')
      expect(sent).toHaveLength(0)
      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        run_id: queued.id,
        workspace_id: acme.workspaceId,
        task_id: 'company.enrich',
        target_id: companyId,
      })
    })

    it('fails a managed agent’s run, naming the module, when the deployment lacks it', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'ai' })
        .where(eq(agentRegistrations.id, agentId))

      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const queued = agentRunSchema.parse(readRecord(await response.json()))
      const settled = agentRunSchema.parse(await settledRun(queued.id))

      expect(settled.status).toBe('failed')
      expect(settled.failureReason).toBe('This agent is run by the "ai" module, which this deployment does not include')
      expect(sent).toHaveLength(0)
    })

    it('answers 404 for an agent that does not exist', async () => {
      const companyId = await createCompany()
      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: 'ag_nobody' },
        cookie: acme.cookie,
      })

      expect(response.status).toBe(404)
      expect(sent).toHaveLength(0)
    })
  })

  describe('agent_tasks.run.settled', () => {
    it('fires once, with ids and the status only, when the endpoint accepts', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      await settledRun(runId)

      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: null, status: 'succeeded' },
      ])

      const envelope = settledEvents[0]

      expect(envelope?.target).toEqual({ type: 'agent_run', id: runId })
      expect(envelope?.workspaceId).toBe(acme.workspaceId)
      expect(envelope?.actor).toEqual({ kind: 'system' })
    })

    it('fires once as failed, without the reason, when the endpoint refuses', async () => {
      outcome = { delivered: false, status: 500, reason: 'agent endpoint answered 500' }

      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      await settledRun(runId)

      const events = await settledEventsFor(runId)

      expect(events).toEqual([{ runId, taskId: 'company.enrich', agentId, managedBy: null, status: 'failed' }])
      expect(JSON.stringify(events)).not.toContain('agent endpoint answered 500')
    })

    it('fires once when a module accepts a managed agent’s run in-process', async () => {
      const agentId = readString(await createAgent(), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'probe' })
        .where(eq(agentRegistrations.id, agentId))

      const runId = await startRun(agentId)

      await settledRun(runId)

      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: 'probe', status: 'succeeded' },
      ])
    })

    it('fires once as failed when the deployment lacks the managing module', async () => {
      const agentId = readString(await createAgent(), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'ai' })
        .where(eq(agentRegistrations.id, agentId))

      const runId = await startRun(agentId)

      await settledRun(runId)

      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: 'ai', status: 'failed' },
      ])
    })

    it('fires once as failed when the stored auth header cannot be decrypted', async () => {
      const agentId = readString(await createAgent({ auth_header: 'Bearer dispatch-key' }), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ authHeaderEncrypted: 'not-a-sealed-value' })
        .where(eq(agentRegistrations.id, agentId))

      const runId = await startRun(agentId)
      const settled = agentRunSchema.parse(await settledRun(runId))

      expect(settled.failureReason).toContain('could not be decrypted')
      expect(sent).toHaveLength(0)
      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: null, status: 'failed' },
      ])
    })

    it('fires once as failed when the dispatch itself throws', async () => {
      const agentId = readString(await createAgent(), 'id')
      await database.db
        .update(agentRegistrations)
        .set({ managedBy: 'thrower' })
        .where(eq(agentRegistrations.id, agentId))

      const runId = await startRun(agentId)
      const settled = agentRunSchema.parse(await settledRun(runId))

      expect(settled.failureReason).toBe('Error: the dispatcher threw')
      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: 'thrower', status: 'failed' },
      ])
    })

    it('does not fire while the run is queued or running', async () => {
      let release: (answer: DispatchOutcome) => void = () => undefined
      const held = new Promise<DispatchOutcome>((resolve) => {
        release = resolve
      })
      pending = held

      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      // The sender is called only after the `queued → running` write.
      for (let attempt = 0; attempt < 100 && sent.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      expect(sent).toHaveLength(1)

      const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, runId))

      expect(row?.status).toBe('running')

      await harness.services.events.drain()

      expect(settledEvents).toHaveLength(0)

      release(DELIVERED)
      await settledRun(runId)

      expect(await settledEventsFor(runId)).toHaveLength(1)
    })

    it('does not fire for a run that went with its registration mid-dispatch', async () => {
      const { runId, agent, logLines, dispatch } = await directDispatch(async () => {
        // The cascade removes the run while the engine holds it at `running`.
        await database.db.delete(agentRegistrations).where(eq(agentRegistrations.id, agent.id))
        return DELIVERED
      })

      await dispatch()
      await harness.services.events.drain()

      expect(await database.db.select().from(agentRuns).where(eq(agentRuns.id, runId))).toHaveLength(0)
      expect(settledEvents).toHaveLength(0)
      // Nothing to settle is not a failure: the engine logs no error for it.
      expect(logLines.filter((line) => line.includes('"level":"error"'))).toEqual([])
    })

    it('fires once when two dispatches settle the same run', async () => {
      // Both engines reach the send before either settles, so neither one's
      // `running` write can reopen a run the other has already ended.
      let arrived = 0
      let releaseBoth: () => void = () => undefined
      const bothArrived = new Promise<void>((resolve) => {
        releaseBoth = resolve
      })
      const barrier: SendDispatch = async () => {
        arrived += 1
        if (arrived === 2) {
          releaseBoth()
        }
        await bothArrived
        return DELIVERED
      }

      const first = await directDispatch(barrier)
      const second = directEngine(barrier)

      await Promise.all([first.dispatch(), second.engine.dispatch(first.run, first.agent, first.resolved)])
      await harness.services.events.drain()

      const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, first.runId))

      expect(row?.status).toBe('succeeded')
      expect(settledEvents.map((event) => event.data)).toEqual([
        {
          runId: first.runId,
          taskId: 'company.enrich',
          agentId: first.agent.id,
          managedBy: null,
          status: 'succeeded',
        },
      ])
      expect(
        [...first.logLines, ...second.logLines].filter((line) => line.includes('"level":"error"')),
      ).toEqual([])
    })
  })

  describe('GET /v1/agent-runs', () => {
    it('lists newest first and filters by status and agent', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')

      const first = agentRunSchema.parse(
        readRecord(
          await (
            await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
              body: { target_type: 'company', target_id: companyId, agent_id: agentId },
              cookie: acme.cookie,
            })
          ).json(),
        ),
      )
      await settledRun(first.id)

      outcome = { delivered: false, status: null, reason: 'connection refused' }

      const second = agentRunSchema.parse(
        readRecord(
          await (
            await client.send('POST', '/v1/agent-tasks/company.refresh_summary/run', {
              body: { target_type: 'company', target_id: companyId, agent_id: agentId },
              cookie: acme.cookie,
            })
          ).json(),
        ),
      )
      await settledRun(second.id)

      const listed = readList(
        await (await client.send('GET', '/v1/agent-runs', { cookie: acme.cookie })).json(),
      ).map((run) => agentRunSchema.parse(run))

      expect(listed.map((run) => run.id)).toEqual([second.id, first.id])

      const failed = readList(
        await (
          await client.send('GET', '/v1/agent-runs?status=failed', { cookie: acme.cookie })
        ).json(),
      )

      expect(failed.map((run) => readString(readRecord(run), 'id'))).toEqual([second.id])

      const byAgent = readList(
        await (
          await client.send('GET', `/v1/agent-runs?agent_id=${agentId}`, { cookie: acme.cookie })
        ).json(),
      )

      expect(byAgent).toHaveLength(2)
    })

    it('hides another workspace’s runs', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      const created = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const run = agentRunSchema.parse(readRecord(await created.json()))
      await settledRun(run.id)

      const stranger = await client.owner('rival3@example.com')

      expect(
        (await client.send('GET', `/v1/agent-runs/${run.id}`, { cookie: stranger.cookie })).status,
      ).toBe(404)
      expect(
        readList(
          await (await client.send('GET', '/v1/agent-runs', { cookie: stranger.cookie })).json(),
        ),
      ).toHaveLength(0)
    })
  })

  describe('services.secretEncryption precedence', () => {
    it('boots the module from services.secretEncryption when SECRET_ENCRYPTION_KEY is missing from the environment', async () => {
      // TEST_ENVIRONMENT normally carries SECRET_ENCRYPTION_KEY, so most suites
      // exercise the fallback. Here it is stripped, and services carries the
      // key instead. If agent-tasks reads through the fallback, boot throws
      // ModuleBootError. Boot succeeding is the whole assertion.
      const { SECRET_ENCRYPTION_KEY, ...environmentWithoutKey } = TEST_ENVIRONMENT

      expect(SECRET_ENCRYPTION_KEY).toBeDefined()

      const overridden = await createTestApp({
        modules: coreModules,
        environment: environmentWithoutKey,
        services: createTestServices({
          db: database.db,
          secretEncryption: { SECRET_ENCRYPTION_KEY: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=' },
        }),
      })

      // Reaching the /v1/agent-tasks surface at all proves the module registered,
      // which the fallback path would have blocked before this branch existed.
      const listed = await overridden.app.request('/v1/agent-tasks')
      expect(listed.status).not.toBe(500)
    })
  })
})

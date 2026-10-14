import {
  agentRunSchema,
  agentTaskDefinitionSchema,
  registeredAgentSchema,
  resolvedAgentTaskSchema,
} from '@kelpie/schemas'
import type { KelpieEvent } from '@kelpie/schemas'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createEgressGuard } from '../../lib/egress.ts'
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
import {
  ABANDONED_RUN_REASON,
  DISPATCH_AGENT_RUN_JOB,
  TARGET_CONVERTED_REASON,
  TARGET_GONE_REASON,
  TASK_GONE_REASON,
  createDispatchEngine,
  createHttpSender,
} from './dispatch.ts'
import type { DispatchEngine, DispatchOutcome, DispatchRequest, SendDispatch } from './dispatch.ts'
import type { AgentRunSettledData } from './events.ts'
import { createAgentTasksModule } from './index.ts'
import { findAgent, insertRun } from './repository.ts'
import type { AgentRecord, RunRecord } from './repository.ts'
import { decisions } from '../decisions/schema.ts'
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

  /**
   * Runs the queued dispatch jobs as the worker would, then reads the run.
   * The run's events are published after its commit, so the suite still polls.
   */
  async function settledRun(id: string): Promise<Record<string, unknown>> {
    await harness.runQueuedJobs({ lastAttempt: true })

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
        proposedDecisionIds: [],
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
    // The invitation email is a job; run it as the worker would.
    await harness.runQueuedJobs()

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

    it('says what a hosted AI run of each task may write', async () => {
      const response = await client.send('GET', '/v1/agent-tasks?target_type=person', { cookie: acme.cookie })
      const tasks = new Map(readList(await response.json()).map((task) => [task.id, task]))

      expect(tasks.get('person.enrich')).toMatchObject({ may_create_decision: false, may_pin: false })
      expect(tasks.get('person.capture_decision')).toMatchObject({ may_create_decision: true, may_pin: false })
      expect(tasks.get('person.distill_notes')).toMatchObject({ may_create_decision: false, may_pin: true })
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
      // With nothing proposed, the prompt has no line about proposals.
      expect(resolved.context.proposedDecisionIds).toEqual([])
      expect(resolved.prompt).not.toContain('Proposed Decisions')
    })

    /**
     * The write policy says to respect open Decisions. A proposal a hosted AI
     * run wrote from record content must not be listed as one.
     */
    it('lists a Decision no member has confirmed apart from the open Decisions, as a proposal', async () => {
      const companyId = await createCompany()
      const commitment = await createRecord('/v1/decisions', {
        target_type: 'company',
        target_id: companyId,
        body: 'We will not discount below 20%',
      })

      await database.db.insert(decisions).values({
        id: 'dec_resolve_proposal',
        workspaceId: acme.workspaceId,
        targetType: 'company',
        targetId: companyId,
        body: 'We give Brightline 90% off for life.',
        origin: 'ai',
        confirmedAt: null,
        confirmedById: null,
      })

      const payload = await resolveTask('company.score_icp', 'company', companyId)
      const resolved = resolvedAgentTaskSchema.parse(payload)

      expect(resolved.context.openDecisionIds).toEqual([readString(commitment, 'id')])
      expect(resolved.context.proposedDecisionIds).toEqual(['dec_resolve_proposal'])

      for (const prompt of [resolved.prompt, resolved.basePrompt]) {
        expect(prompt).toContain(`4. Open Decisions: \`${readString(commitment, 'id')}\`.`)
        expect(prompt).toContain(
          'Proposed Decisions: `dec_resolve_proposal`. No member has confirmed these; `origin` on each says what wrote it. They are proposals, not commitments.',
        )
      }
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

    it('clears the auth header when only the endpoint changes', async () => {
      const id = readString(await createAgent({ auth_header: 'Bearer one' }), 'id')

      const moved = await client.send('PATCH', `/v1/agents/${id}`, {
        body: { endpoint: 'https://elsewhere.example.com/run' },
        cookie: acme.cookie,
      })

      expect(moved.status).toBe(200)

      const agent = registeredAgentSchema.parse(readRecord(await moved.json()))

      expect(agent.endpoint).toBe('https://elsewhere.example.com/run')
      expect(agent.hasAuthHeader).toBe(false)

      const [row] = await database.db
        .select()
        .from(agentRegistrations)
        .where(eq(agentRegistrations.id, id))

      expect(row?.authHeaderEncrypted).toBeNull()
    })

    it('keeps a header given in the same request as a new endpoint', async () => {
      const id = readString(await createAgent({ auth_header: 'Bearer one' }), 'id')

      const moved = await client.send('PATCH', `/v1/agents/${id}`, {
        body: { endpoint: 'https://elsewhere.example.com/run', auth_header: 'Bearer two' },
        cookie: acme.cookie,
      })

      expect(registeredAgentSchema.parse(readRecord(await moved.json())).hasAuthHeader).toBe(true)
    })

    it('keeps the header when the endpoint is sent unchanged or only the name changes', async () => {
      const created = await createAgent({ auth_header: 'Bearer one' })
      const id = readString(created, 'id')

      const same = await client.send('PATCH', `/v1/agents/${id}`, {
        body: { name: 'Renamed', endpoint: readString(created, 'endpoint') },
        cookie: acme.cookie,
      })

      expect(registeredAgentSchema.parse(readRecord(await same.json())).hasAuthHeader).toBe(true)
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

  /**
   * The real sender behind an egress guard whose resolver is injected, so no
   * request leaves. Every member reads a run's reason, and what a host name
   * resolves to inside the deployment's network is not theirs to learn.
   */
  describe('an endpoint the egress guard refuses', () => {
    const REFUSED_ADDRESS = '10.0.0.5'

    it.each([
      { name: 'before the request', answers: [[REFUSED_ADDRESS]] },
      // DNS rebinding: the check sees a public address, and the connection a private one.
      { name: 'at the connection', answers: [['93.184.216.34'], [REFUSED_ADDRESS]] },
    ])('keeps the address off the run and gives it to the log, $name', async ({ answers }) => {
      const remaining = [...answers]
      const guard = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () =>
        Promise.resolve(remaining.shift() ?? [REFUSED_ADDRESS]),
      )
      const { runId, logLines, dispatch } = await directDispatch(createHttpSender(guard))

      await dispatch()

      const response = await client.send('GET', `/v1/agent-runs/${runId}`, { cookie: acme.cookie })
      const body = await response.text()
      const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, runId))

      expect(row?.status).toBe('failed')
      expect(row?.failureReason).toBe(
        'BlockedEgressError: Refusing to connect to agents.example.com: the host has a private or reserved address',
      )
      expect(JSON.stringify(row)).not.toContain(REFUSED_ADDRESS)
      expect(body).toContain('private or reserved address')
      expect(body).not.toContain(REFUSED_ADDRESS)

      const failures = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.message === 'agent dispatch failed')

      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ level: 'warn', runId, blockedAddress: REFUSED_ADDRESS })
    })

    it('adds no address to the log line of a failure the guard did not cause', async () => {
      const { logLines, dispatch } = await directDispatch(
        createHttpSender(createEgressGuard({ BLOCK_PRIVATE_EGRESS: false }), () =>
          Promise.reject(new TypeError('fetch failed')),
        ),
      )

      await dispatch()

      const failures = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.message === 'agent dispatch failed')

      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({ reason: 'TypeError: fetch failed' })
      expect(failures[0]).not.toHaveProperty('blockedAddress')
    })
  })

  /** The reason lands on the run, which every member reads. */
  describe('the HTTP sender', () => {
    const request: DispatchRequest = {
      url: 'https://agents.example.com/kelpie/run',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    }
    const allowAll = createEgressGuard({ BLOCK_PRIVATE_EGRESS: false })

    it('names the network fault by its code, and never by the address it connected to', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' })
      const sender = createHttpSender(allowAll, () => Promise.reject(new TypeError('fetch failed', { cause })))
      const outcome = await sender(request)

      expect(outcome).toMatchObject({ delivered: false, status: null, reason: 'TypeError: fetch failed (ECONNREFUSED)' })
    })

    it('stops waiting on a DNS check that hangs when the job expires', async () => {
      const hanging = createEgressGuard({ BLOCK_PRIVATE_EGRESS: true }, () => new Promise<never>(() => undefined))
      let fetched = false
      const sender = createHttpSender(hanging, () => {
        fetched = true

        return Promise.resolve(new Response(null, { status: 202 }))
      })
      const job = new AbortController()
      const sending = sender(request, job.signal)

      job.abort(new Error('the job expired'))

      expect(await sending).toMatchObject({ delivered: false, status: null, reason: 'Error: the job expired' })
      expect(fetched).toBe(false)
    })

    it('gives the whole cause to the log detail and keeps it out of the reason', async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED' })
      const sender = createHttpSender(allowAll, () => Promise.reject(new TypeError('fetch failed', { cause })))
      const outcome = await sender(request)

      expect(outcome.reason).not.toContain('10.0.0.5')
      expect(outcome.logDetail).toContain('10.0.0.5')
    })

    it('lets go of the response body without reading it', async () => {
      let cancelled = false
      const body = new ReadableStream({
        cancel() {
          cancelled = true
        },
      })
      const sender = createHttpSender(allowAll, () => Promise.resolve(new Response(body, { status: 202 })))

      expect((await sender(request)).delivered).toBe(true)
      await expect.poll(() => cancelled).toBe(true)
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
      const working = harness.runQueuedJobs({ lastAttempt: true })

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
      await working
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

    it('sends a run once when two dispatches of it start together', async () => {
      // Both dispatches start from the same queued row; only the one whose
      // `queued → running` write lands sends, and the other does nothing.
      const first = await directDispatch(send)
      const second = directEngine(send)

      await Promise.all([first.dispatch(), second.engine.dispatch(first.run, first.agent, first.resolved)])
      await harness.services.events.drain()

      const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, first.runId))

      expect(row?.status).toBe('succeeded')
      expect(sent).toHaveLength(1)
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

  /**
   * The `agent-tasks.dispatch` job: enqueued with the run, and run by the
   * suite as a worker would, or by an engine of its own.
   */
  describe('the dispatch job', () => {
    function queuedDispatches(): unknown[] {
      return harness.services.queuedJobs.filter((job) => job.name === DISPATCH_AGENT_RUN_JOB).map((job) => job.data)
    }

    async function runRow(id: string): Promise<RunRecord | undefined> {
      const [row] = await database.db.select().from(agentRuns).where(eq(agentRuns.id, id))

      return row
    }

    it('is enqueued with the run, carries its ids only, and sends nothing until it runs', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      expect(queuedDispatches()).toEqual([{ workspaceId: acme.workspaceId, runId, targetType: 'company' }])
      expect(
        harness.services.queuedJobs.filter((job) => job.name === DISPATCH_AGENT_RUN_JOB).map((job) => job.options),
      ).toEqual([{ group: { id: acme.workspaceId } }])
      expect(sent).toEqual([])
      expect((await runRow(runId))?.status).toBe('queued')

      await harness.runQueuedJobs({ lastAttempt: true })

      expect(sent).toHaveLength(1)
      expect((await runRow(runId))?.status).toBe('succeeded')
    })

    it('does nothing for a run that is no longer queued', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)
      const [job] = harness.services.queuedJobs

      await settledRun(runId)

      if (job === undefined) {
        throw new Error('No dispatch job was queued')
      }

      // The same job again, as after a worker that settled the run and stopped.
      harness.services.queuedJobs.push(job)
      await harness.runQueuedJobs({ lastAttempt: true })
      await harness.services.events.drain()

      expect(sent).toHaveLength(1)
      expect(settledEvents).toHaveLength(1)
    })

    it('fails the run, and sends nothing, when its target was deleted before the job ran', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      const response = await client.send('POST', '/v1/agent-tasks/company.enrich/run', {
        body: { target_type: 'company', target_id: companyId, agent_id: agentId },
        cookie: acme.cookie,
      })
      const runId = readString(readRecord(await response.json()), 'id')

      expect((await client.send('DELETE', `/v1/companies/${companyId}`, { cookie: acme.cookie })).status).toBe(204)

      const settled = agentRunSchema.parse(await settledRun(runId))

      expect(settled.status).toBe('failed')
      expect(settled.failureReason).toBe(TARGET_GONE_REASON)
      expect(sent).toEqual([])
      expect(await settledEventsFor(runId)).toEqual([
        { runId, taskId: 'company.enrich', agentId, managedBy: null, status: 'failed' },
      ])
    })

    it('fails the run when its task is not in the deployment any more', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      await database.db.update(agentRuns).set({ taskId: 'company.retired' }).where(eq(agentRuns.id, runId))

      const settled = agentRunSchema.parse(await settledRun(runId))

      expect(settled.status).toBe('failed')
      expect(settled.failureReason).toBe(TASK_GONE_REASON)
      expect(sent).toEqual([])
    })

    it('fails the run when a conversion moved it to a record of another type before the job ran', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)
      const personId = readString(await createRecord('/v1/people', { name: 'Ada Lovelace' }), 'id')

      // What `conversions/repoint.ts` does to the run when its record is
      // converted: the run moves to a record of another type.
      await database.db
        .update(agentRuns)
        .set({ targetType: 'person', targetId: personId })
        .where(eq(agentRuns.id, runId))

      const settled = agentRunSchema.parse(await settledRun(runId))

      expect(settled.status).toBe('failed')
      expect(settled.failureReason).toBe(TARGET_CONVERTED_REASON)
      expect(sent).toEqual([])
    })

    it('logs a dispatch that settles after the dead-letter handler ended its run', async () => {
      const { engine } = directEngine(send)
      const first = await directDispatch(async () => {
        // The job expired while the POST was in flight: the dead-letter
        // handler fails the run before the POST answers.
        await engine.failAbandonedRun(
          { workspaceId: acme.workspaceId, runId: first.runId, targetType: 'company' },
          createLogger({ level: 'error', transports: [] }),
        )

        return DELIVERED
      })

      await first.dispatch()
      await harness.services.events.drain()

      const row = await runRow(first.runId)

      expect(row?.status).toBe('failed')
      expect(row?.failureReason).toBe(ABANDONED_RUN_REASON)
      expect(
        first.logLines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.message === 'agent run had already ended when its dispatch settled'),
      ).toEqual([expect.objectContaining({ level: 'warn', runId: first.runId, delivered: true })])
    })

    it.each(['queued', 'running'] as const)('fails a run left %s by a dispatch that never finished, once', async (status) => {
      const { runId, agent } = await directDispatch(send)
      const { engine } = directEngine(send)
      const log = createLogger({ level: 'error', transports: [] })

      await database.db.update(agentRuns).set({ status }).where(eq(agentRuns.id, runId))

      await engine.failAbandonedRun({ workspaceId: acme.workspaceId, runId, targetType: 'company' }, log)
      await engine.failAbandonedRun({ workspaceId: acme.workspaceId, runId, targetType: 'company' }, log)
      await harness.services.events.drain()

      const row = await runRow(runId)

      expect(row?.status).toBe('failed')
      expect(row?.failureReason).toBe(ABANDONED_RUN_REASON)
      expect(sent).toEqual([])
      expect(settledEvents.map((event) => event.data)).toEqual([
        { runId, taskId: 'company.enrich', agentId: agent.id, managedBy: null, status: 'failed' },
      ])
    })

    it('leaves a settled run alone in the dead-letter handler', async () => {
      const agentId = readString(await createAgent(), 'id')
      const runId = await startRun(agentId)

      await settledRun(runId)

      const { engine } = directEngine(send)

      await engine.failAbandonedRun({ workspaceId: acme.workspaceId, runId, targetType: 'company' }, createLogger({ level: 'error', transports: [] }))

      expect((await runRow(runId))?.status).toBe('succeeded')
    })

    /**
     * Against the real queue, so the job row and the run share a transaction.
     * A deferred constraint trigger fails the commit after the job was
     * inserted, which is the one place a rollback can still happen.
     */
    describe('on the real queue', () => {
      async function realQueueApp(): Promise<{ app: TestApp; client: TestClient }> {
        await database.jobs.start()

        const app = await createTestApp({
          modules: [
            ...coreModules.filter((module) => module.id !== 'agent-tasks'),
            createAgentTasksModule(coreMigrationsDirectory, { send }),
          ],
          environment: TEST_ENVIRONMENT,
          services: createTestServices({ db: database.db, enqueueOnTx: database.jobs.enqueueOnTx }),
        })

        return { app, client: createTestClient(app.app, app.services.db) }
      }

      async function dispatchJobRows(): Promise<unknown[]> {
        const rows = await database.db.execute<{ data: unknown }>(
          sql`select data from pgboss.job where name = ${DISPATCH_AGENT_RUN_JOB}`,
        )

        return rows.map((row) => row.data)
      }

      async function runAs(target: TestClient, cookie: string): Promise<Response> {
        const company = await target.send('POST', '/v1/companies', { body: { name: 'Brightline Health' }, cookie })
        const agent = await target.send('POST', '/v1/agents', {
          body: { name: 'Local Claude', endpoint: 'https://agents.example.com/kelpie/run' },
          cookie,
        })

        return target.send('POST', '/v1/agent-tasks/company.enrich/run', {
          body: {
            target_type: 'company',
            target_id: readString(readRecord(await company.json()), 'id'),
            agent_id: readString(readRecord(await agent.json()), 'id'),
          },
          cookie,
        })
      }

      it('commits the job with the run', async () => {
        const real = await realQueueApp()
        const owner = await real.client.owner('real-queue@example.com')
        const response = await runAs(real.client, owner.cookie)

        expect(response.status).toBe(201)
        expect(await dispatchJobRows()).toEqual([
          {
            workspaceId: owner.workspaceId,
            runId: readString(readRecord(await response.json()), 'id'),
            targetType: 'company',
          },
        ])
      })

      it('leaves no job when the run rolls back', async () => {
        const real = await realQueueApp()
        const owner = await real.client.owner('rolled-back@example.com')

        await database.db.execute(sql`
          create or replace function refuse_agent_run() returns trigger language plpgsql as $$
          begin raise exception 'refused by the test'; end $$
        `)
        await database.db.execute(sql`
          create constraint trigger refuse_agent_run after insert on agent_runs
          deferrable initially deferred for each row execute function refuse_agent_run()
        `)

        try {
          const response = await runAs(real.client, owner.cookie)

          expect(response.status).toBe(500)
          expect(await dispatchJobRows()).toEqual([])
          expect(await database.db.select().from(agentRuns)).toEqual([])
        } finally {
          await database.db.execute(sql`drop trigger if exists refuse_agent_run on agent_runs`)
          await database.db.execute(sql`drop function if exists refuse_agent_run()`)
        }
      })
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

  describe('scopes of a resolve and of a run', () => {
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

    function resolveWith(bearer: string, taskId: string, targetType: string, targetId: string): Promise<Response> {
      return client.send('POST', `/v1/agent-tasks/${taskId}/resolve`, {
        body: { target_type: targetType, target_id: targetId },
        bearer,
      })
    }

    async function runCount(): Promise<number> {
      const response = await client.send('GET', '/v1/agent-runs', { cookie: acme.cookie })

      return readList(await response.json()).length
    }

    it('refuses a resolve to a key with agent_tasks:write and no read scope for the target', async () => {
      const companyId = await createCompany('Brightline Health')
      const tasksOnly = await key(['agent_tasks:write'])
      const refused = await resolveWith(tasksOnly, 'company.score_icp', 'company', companyId)

      expect(refused.status).toBe(403)

      const body = await refused.text()

      expect(body).toContain('This API key does not have the companies:read scope')
      expect(body).not.toContain('Brightline Health')

      // The read scope of another type does not help.
      const wrongType = await resolveWith(
        await key(['agent_tasks:write', 'people:read']),
        'company.score_icp',
        'company',
        companyId,
      )

      expect(wrongType.status).toBe(403)

      // The answer for a target that does not exist is the same, so the key
      // cannot find out which ids exist.
      const missing = await resolveWith(tasksOnly, 'company.score_icp', 'company', 'com_missing')

      expect(missing.status).toBe(403)
    })

    it('resolves for a key that can read the target type, by name or through a preset', async () => {
      const companyId = await createCompany('Brightline Health')

      for (const scopes of [
        ['agent_tasks:write', 'companies:read'],
        ['agent_tasks:write', 'companies:write'],
        ['agent_tasks:write', 'read:objects'],
        [],
      ]) {
        const response = await resolveWith(await key(scopes), 'company.score_icp', 'company', companyId)

        expect(response.status, scopes.join(',')).toBe(200)
      }
    })

    it('needs dashboard:read to resolve a workspace task, and handbook:read for a handbook page', async () => {
      const tasksOnly = await key(['agent_tasks:write'])
      const workspaceTask = await resolveWith(tasksOnly, 'workspace.empty_field_sweep', 'workspace', acme.workspaceId)

      expect(workspaceTask.status).toBe(403)
      expect(await errorMessage(workspaceTask)).toBe('This API key does not have the dashboard:read scope')
      expect(
        (
          await resolveWith(
            await key(['agent_tasks:write', 'dashboard:read']),
            'workspace.empty_field_sweep',
            'workspace',
            acme.workspaceId,
          )
        ).status,
      ).toBe(200)

      const handbookTask = await resolveWith(tasksOnly, 'handbook.draft_update', 'handbook', 'hbk_any')

      expect(handbookTask.status).toBe(403)
      expect(await errorMessage(handbookTask)).toBe('This API key does not have the handbook:read scope')
    })

    it('refuses a run to a key that lacks a scope for what the run may write, and starts nothing', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      const start = (bearer: string, taskId = 'company.enrich'): Promise<Response> =>
        client.send('POST', `/v1/agent-tasks/${taskId}/run`, {
          body: { target_type: 'company', target_id: companyId, agent_id: agentId },
          bearer,
        })

      const cases: readonly (readonly [readonly string[], string, string])[] = [
        [['agent_tasks:write'], 'company.enrich', 'companies:read'],
        [['agent_tasks:write', 'companies:read'], 'company.enrich', 'notes:write'],
        [['agent_tasks:write', 'companies:read', 'notes:write'], 'company.enrich', 'companies:write'],
        // This task may create a Decision, so it needs the scope to write one.
        [['agent_tasks:write', 'companies:write', 'notes:write'], 'company.capture_decision', 'decisions:write'],
      ]

      for (const [scopes, taskId, missing] of cases) {
        const refused = await start(await key(scopes), taskId)

        expect(refused.status, scopes.join(',')).toBe(403)
        expect(await errorMessage(refused)).toBe(`This API key does not have the ${missing} scope`)
      }

      expect(await runCount()).toBe(0)
      expect(sent).toHaveLength(0)
    })

    it('starts a run for a key that holds every scope the run needs', async () => {
      const companyId = await createCompany()
      const agentId = readString(await createAgent(), 'id')
      const start = (bearer: string, taskId: string): Promise<Response> =>
        client.send('POST', `/v1/agent-tasks/${taskId}/run`, {
          body: { target_type: 'company', target_id: companyId, agent_id: agentId },
          bearer,
        })

      const granular = await start(
        await key(['agent_tasks:write', 'companies:write', 'notes:write']),
        'company.enrich',
      )

      expect(granular.status).toBe(201)

      const withDecision = await start(
        await key(['agent_tasks:write', 'companies:write', 'notes:write', 'decisions:write']),
        'company.capture_decision',
      )

      expect(withDecision.status).toBe(201)

      for (const scopes of [['write:admin', 'write:objects'], ['write:all'], []]) {
        const response = await start(await key(scopes), 'company.capture_decision')

        expect(response.status, scopes.join(',')).toBe(201)
      }

      for (const run of readList(await (await client.send('GET', '/v1/agent-runs', { cookie: acme.cookie })).json())) {
        await settledRun(readString(run, 'id'))
      }
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

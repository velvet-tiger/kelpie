import {
  agentRunSchema,
  agentTaskDefinitionSchema,
  registeredAgentSchema,
  resolvedAgentTaskSchema,
} from '@kelpie/schemas'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestApp } from '../../testing/app.ts'
import type { TestApp } from '../../testing/app.ts'
import { createTestClient, readList, readRecord, readString } from '../../testing/client.ts'
import type { TestClient, TestOwner } from '../../testing/client.ts'
import { connectTestDatabase, testDatabaseUrl } from '../../testing/database.ts'
import type { TestDatabase } from '../../testing/database.ts'
import { TEST_ENVIRONMENT } from '../../testing/environment.ts'
import { createTestServices } from '../../testing/services.ts'
import { coreMigrationsDirectory, coreModules } from '../core.ts'
import type { DispatchOutcome, DispatchRequest, SendDispatch } from './dispatch.ts'
import { createAgentTasksModule } from './index.ts'

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

const INVITE_TEMPLATE = 'https://app.example.com/join?token={token}'

describe.skipIf(connectionString === undefined)('agent tasks', () => {
  let database: TestDatabase
  let harness: TestApp
  let client: TestClient
  let acme: TestOwner

  /** What the fake sender was asked to send, and what it answers with. */
  let sent: DispatchRequest[]
  let outcome: DispatchOutcome

  const send: SendDispatch = (request) => {
    sent.push(request)

    return Promise.resolve(outcome)
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
    outcome = DELIVERED

    harness = await createTestApp({
      // The one module swapped for a configured copy. Order is resolved from
      // `requires`, so appending it is the same registration order as core's.
      modules: [
        ...coreModules.filter((module) => module.id !== 'agent-tasks'),
        createAgentTasksModule(coreMigrationsDirectory, { send }),
      ],
      environment: TEST_ENVIRONMENT,
      services: createTestServices({ db: database.db }),
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

  /** Invites an address as a plain member and accepts as a fresh account. */
  async function addMember(email: string, role: 'admin' | 'member'): Promise<string> {
    const invited = await client.send('POST', `/v1/workspaces/${acme.workspaceId}/invites`, {
      body: { email, role, invite_url_template: INVITE_TEMPLATE },
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

      expect(tasks).toHaveLength(69)
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
      const stranger = await client.owner('rival@example.com', 'rival')
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
      const stranger = await client.owner('rival2@example.com', 'rival2')

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

      const queued = agentRunSchema.parse(readRecord(await response.json()))

      expect(queued.status).toBe('queued')
      expect(queued.agentId).toBe(agentId)
      // Copy and Run must not drift: the dispatched prompt is the resolve prompt.
      expect(queued.prompt).toBe(resolved.prompt)

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

      const stranger = await client.owner('rival3@example.com', 'rival3')

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
})

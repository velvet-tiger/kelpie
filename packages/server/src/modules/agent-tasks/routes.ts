import { AGENT_RUN_STATUSES, AGENT_TASK_TARGET_TYPES } from '@kelpie/schemas'
import type { AgentRunStatus, AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import { pageBody, readJsonBody, readListParameters } from '../../lib/http.ts'
import { endpointUrlProblem } from '../../lib/url.ts'
import type { Actor } from '../auth/actor.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import type { AgentTasksService, AgentView, RunView } from './service.ts'
import { resolvedTaskResponse } from './wire.ts'

/**
 * Wire shapes for `/v1/agent-tasks`, `/v1/agent-runs` and `/v1/agents`.
 *
 * Bodies are strict: `api.md` makes an unknown field a 422 rather than
 * something dropped in silence. Everything is `snake_case` on the wire —
 * `agent-tasks.md`'s examples predate that convention and `api.md` wins.
 */

const CREDENTIALS_MESSAGE = 'Remove the credentials from the URL; use auth_header instead'

const endpointField = z
  .string()
  .refine((value) => endpointUrlProblem(value, CREDENTIALS_MESSAGE) === undefined, {
    error: (issue) =>
      endpointUrlProblem(String(issue.input), CREDENTIALS_MESSAGE)?.message ?? 'Invalid URL',
  })

const targetTypeField = z.enum(AGENT_TASK_TARGET_TYPES)

export const resolveBody = z.strictObject({
  target_type: targetTypeField,
  target_id: z.string().min(1),
})

export const runBody = z.strictObject({
  target_type: targetTypeField,
  target_id: z.string().min(1),
  agent_id: z.string().min(1),
})

export const createAgentBody = z.strictObject({
  name: z.string().min(1),
  endpoint: endpointField,
  auth_header: z.string().min(1).optional(),
})

/** `auth_header: null` clears the stored header; a string replaces it. */
export const updateAgentBody = z
  .strictObject({
    name: z.string().min(1),
    endpoint: endpointField,
    auth_header: z.string().min(1).nullable(),
  })
  .partial()

export function taskDefinitionResponse(definition: AgentTaskDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    target_types: definition.targetTypes,
    placement: definition.placement,
    handbook_slugs: definition.handbookSlugs,
    instructions: definition.instructions,
    write_policy: definition.writePolicy,
  }
}

export function agentResponse(agent: AgentView): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    endpoint: agent.endpoint,
    has_auth_header: agent.hasAuthHeader,
    last_run_at: agent.lastRunAt === null ? null : agent.lastRunAt.toISOString(),
    created_at: agent.createdAt.toISOString(),
    updated_at: agent.updatedAt.toISOString(),
  }
}

export function runResponse(run: RunView): Record<string, unknown> {
  return {
    id: run.id,
    agent_id: run.agentId,
    task_id: run.taskId,
    target_type: run.targetType,
    target_id: run.targetId,
    status: run.status,
    prompt: run.prompt,
    failure_reason: run.failureReason,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  }
}

/**
 * Reads an optional query value against a fixed list.
 *
 * @throws AppError 422 for a value outside the list. Answering it with an empty
 *   result would read as "none of those" rather than "no such value".
 */
function readEnumFilter<Value extends string>(
  context: Context,
  name: string,
  values: readonly [Value, ...Value[]],
): Value | undefined {
  const raw = context.req.query(name)

  if (raw === undefined) {
    return undefined
  }

  const parsed = z.enum(values).safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed(`That is not a ${name.replace('_', ' ')}`, [
      { field: name, message: `Use one of: ${values.join(', ')}` },
    ])
  }

  return parsed.data
}

/** A blank id filter asks a different question than the one intended, per `api.md`. */
function readIdQuery(context: Context, name: string): string | undefined {
  const raw = context.req.query(name)

  if (raw === undefined) {
    return undefined
  }

  if (raw.length === 0) {
    throw AppError.validationFailed(`${name} must not be blank`, [
      { field: name, message: 'Provide an id or omit the parameter' },
    ])
  }

  return raw
}

export interface AgentTasksRoutesDependencies extends CredentialDependencies {
  readonly service: AgentTasksService
}

export function mountAgentTasksRoutes(
  router: Hono,
  dependencies: AgentTasksRoutesDependencies,
): void {
  const requireActor = (context: Context): Promise<Actor> => resolveActorFrom(dependencies, context)

  /**
   * The catalog, optionally narrowed to one target type. Code, not rows: the
   * whole list rides in one response with no cursor, the `/v1/mcp/tools` shape.
   */
  router.get('/agent-tasks', async (context) => {
    const targetType = readEnumFilter<AgentTaskTargetType>(
      context,
      'target_type',
      AGENT_TASK_TARGET_TYPES,
    )
    const tasks = await dependencies.service.listTasks(await requireActor(context), targetType)

    return context.json({ data: tasks.map(taskDefinitionResponse), next_cursor: null })
  })

  router.post('/agent-tasks/:taskId/resolve', async (context) => {
    const body = await readJsonBody(context, resolveBody)
    const resolved = await dependencies.service.resolve(
      await requireActor(context),
      context.req.param('taskId'),
      { targetType: body.target_type, targetId: body.target_id },
    )

    return context.json(resolvedTaskResponse(resolved))
  })

  /** Creates the run and answers `queued`; the dispatch happens after. */
  router.post('/agent-tasks/:taskId/run', async (context) => {
    const body = await readJsonBody(context, runBody)
    const run = await dependencies.service.run(
      await requireActor(context),
      context.req.param('taskId'),
      { targetType: body.target_type, targetId: body.target_id, agentId: body.agent_id },
    )

    return context.json(runResponse(run), 201)
  })

  router.get('/agent-runs', async (context) => {
    const page = await dependencies.service.listRuns(
      await requireActor(context),
      {
        agentId: readIdQuery(context, 'agent_id'),
        status: readEnumFilter<AgentRunStatus>(context, 'status', AGENT_RUN_STATUSES),
      },
      readListParameters(context),
    )

    return context.json(pageBody(page, runResponse))
  })

  router.get('/agent-runs/:id', async (context) => {
    const run = await dependencies.service.getRun(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(runResponse(run))
  })

  router.get('/agents', async (context) => {
    const page = await dependencies.service.listAgents(
      await requireActor(context),
      readListParameters(context),
    )

    return context.json(pageBody(page, agentResponse))
  })

  router.post('/agents', async (context) => {
    const body = await readJsonBody(context, createAgentBody)
    const agent = await dependencies.service.createAgent(await requireActor(context), {
      name: body.name,
      endpoint: body.endpoint,
      authHeader: body.auth_header,
    })

    return context.json(agentResponse(agent), 201)
  })

  router.get('/agents/:id', async (context) => {
    const agent = await dependencies.service.getAgent(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json(agentResponse(agent))
  })

  router.patch('/agents/:id', async (context) => {
    const body = await readJsonBody(context, updateAgentBody)
    const agent = await dependencies.service.updateAgent(
      await requireActor(context),
      context.req.param('id'),
      { name: body.name, endpoint: body.endpoint, authHeader: body.auth_header },
    )

    return context.json(agentResponse(agent))
  })

  router.delete('/agents/:id', async (context) => {
    await dependencies.service.removeAgent(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })
}

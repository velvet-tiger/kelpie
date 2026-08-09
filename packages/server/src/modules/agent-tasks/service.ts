import type { AgentRunStatus, AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError, describeThrown } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { Logger } from '../../lib/logger.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import { AGENT_TASK_DEFINITIONS, findTask, tasksFor } from './catalog.ts'
import type { DispatchEngine } from './dispatch.ts'
import { renderPrompt } from './prompt.ts'
import * as repository from './repository.ts'
import { AGENT_SORTS, DEFAULT_AGENT_SORT, DEFAULT_RUN_SORT, RUN_SORTS } from './repository.ts'
import type { AgentRecord, RunFilters, RunRecord } from './repository.ts'
import { assemblePromptInputs } from './resolve.ts'
import type { ResolvedTaskView } from './wire.ts'

/**
 * Agent tasks: the catalog, resolve, run dispatch, and registered agents.
 *
 * Roles split by verb, deliberately not the webhooks all-verbs-admin rule.
 * Managing a registration is admin work — its endpoint is where workspace data
 * gets POSTed. But *reading* the list is what the Run dialog on every record
 * page does, and running a task is the product's core loop, so members read
 * agents, resolve tasks, run them, and read the run log. The auth header is the
 * one secret in the module and it is sealed and never returned, so a member
 * reading the list learns an endpoint name, not a credential.
 */

export interface AgentTasksDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly cipher: SecretCipher
  readonly engine: DispatchEngine
  readonly log: Logger
}

/** An agent as the API returns one: never the header, never the tenancy column. */
export interface AgentView {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly hasAuthHeader: boolean
  readonly lastRunAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type RunView = Omit<RunRecord, 'workspaceId'>

export interface ResolveTargetInput {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
}

export interface RunTaskInput extends ResolveTargetInput {
  readonly agentId: string
}

export interface CreateAgentInput {
  readonly name: string
  readonly endpoint: string
  readonly authHeader?: string | undefined
}

export interface UpdateAgentInput {
  readonly name?: string | undefined
  readonly endpoint?: string | undefined
  /** A string replaces the stored header; `null` clears it. */
  readonly authHeader?: string | null | undefined
}

export interface RunListFilters {
  readonly agentId?: string | undefined
  readonly status?: AgentRunStatus | undefined
}

export interface AgentTasksService {
  listTasks(actor: Actor, targetType?: AgentTaskTargetType): Promise<readonly AgentTaskDefinition[]>
  resolve(actor: Actor, taskId: string, target: ResolveTargetInput): Promise<ResolvedTaskView>
  /** Creates the run, answers `queued`, and dispatches after the transaction commits. */
  run(actor: Actor, taskId: string, input: RunTaskInput): Promise<RunView>
  getRun(actor: Actor, id: string): Promise<RunView>
  listRuns(actor: Actor, filters: RunListFilters, query: ListQueryParameters): Promise<Page<RunView>>
  listAgents(actor: Actor, query: ListQueryParameters): Promise<Page<AgentView>>
  getAgent(actor: Actor, id: string): Promise<AgentView>
  createAgent(actor: Actor, input: CreateAgentInput): Promise<AgentView>
  updateAgent(actor: Actor, id: string, changes: UpdateAgentInput): Promise<AgentView>
  removeAgent(actor: Actor, id: string): Promise<void>
}

function toAgentView(record: AgentRecord): AgentView {
  return {
    id: record.id,
    name: record.name,
    endpoint: record.endpoint,
    hasAuthHeader: record.authHeaderEncrypted !== null,
    lastRunAt: record.lastRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toRunView(record: RunRecord): RunView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createAgentTasksService(dependencies: AgentTasksDependencies): AgentTasksService {
  function requireAdminWorkspace(actor: Actor): string {
    const workspaceId = requireWorkspaceId(actor)

    if (actor.role === null || !roleAllows(actor.role, 'admin')) {
      throw new AppError('forbidden', 'This action needs the admin role')
    }

    return workspaceId
  }

  function requireTask(taskId: string): AgentTaskDefinition {
    const definition = findTask(taskId)

    if (definition === undefined) {
      throw AppError.notFound('Agent task not found')
    }

    return definition
  }

  /**
   * A task that exists but does not apply to the named target type is a `422`,
   * not a `404`: the caller found the task, they aimed it wrong.
   */
  function requireTargetType(definition: AgentTaskDefinition, targetType: AgentTaskTargetType): void {
    if (!definition.targetTypes.includes(targetType)) {
      throw AppError.validationFailed('This task does not apply to that target type', [
        {
          field: 'target_type',
          message: `Task ${definition.id} applies to: ${definition.targetTypes.join(', ')}`,
        },
      ])
    }
  }

  async function requireAgent(workspaceId: string, id: string): Promise<AgentRecord> {
    const agent = await repository.findAgent(dependencies.db, workspaceId, id)

    // An agent in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (agent === undefined) {
      throw AppError.notFound('Agent not found')
    }

    return agent
  }

  async function resolveView(
    workspaceId: string,
    definition: AgentTaskDefinition,
    target: ResolveTargetInput,
  ): Promise<ResolvedTaskView> {
    const inputs = await assemblePromptInputs(
      dependencies.db,
      workspaceId,
      definition,
      target.targetType,
      target.targetId,
    )

    if (inputs === undefined) {
      throw AppError.notFound('Target record not found')
    }

    return {
      taskId: definition.id,
      targetType: target.targetType,
      targetId: target.targetId,
      prompt: renderPrompt(definition, target.targetType, target.targetId, inputs),
      context: {
        targetLabel: inputs.targetLabel,
        deepLink: inputs.deepLink,
        handbookSlugs: inputs.handbookPages.map((page) => page.slug),
        pinnedNoteIds: inputs.pinnedNoteIds,
        openPlanIds: inputs.openPlanIds,
        openDecisionIds: inputs.openDecisionIds,
        related: Object.fromEntries(
          Object.entries(inputs.related)
            .filter(([, list]) => list.ids.length > 0)
            .map(([key, list]) => [key, list.ids]),
        ),
      },
    }
  }

  return {
    listTasks(actor, targetType) {
      requireWorkspaceId(actor)

      // The catalog ships in code and is the same for every workspace; the
      // credential check is about who may ask, not whose answer differs.
      return Promise.resolve(
        targetType === undefined ? AGENT_TASK_DEFINITIONS : tasksFor(targetType),
      )
    },

    async resolve(actor, taskId, target) {
      const workspaceId = requireWorkspaceId(actor)
      const definition = requireTask(taskId)

      requireTargetType(definition, target.targetType)

      return resolveView(workspaceId, definition, target)
    },

    async run(actor, taskId, input) {
      const workspaceId = requireWorkspaceId(actor)
      const definition = requireTask(taskId)

      requireTargetType(definition, input.targetType)

      const agent = await requireAgent(workspaceId, input.agentId)
      const resolved = await resolveView(workspaceId, definition, input)
      const now = dependencies.now()

      const created = await dependencies.transaction(async ({ tx }) => {
        const run = await repository.insertRun(tx, {
          id: dependencies.createId('agentRun'),
          workspaceId,
          agentId: agent.id,
          taskId: definition.id,
          targetType: input.targetType,
          targetId: input.targetId,
          status: 'queued',
          prompt: resolved.prompt,
        })

        // `last_run_at` moves; `updated_at` does not. The latter answers "when
        // did somebody last change this registration", the webhook rule.
        await repository.updateAgent(tx, workspaceId, agent.id, { lastRunAt: now })

        return run
      })

      // After the commit, never awaited: the caller polls the run instead.
      // `dispatch` settles every failure into the run row; this catch guards
      // the promise chain itself so nothing leaks an unhandled rejection.
      dependencies.engine.dispatch(created, agent, resolved).catch((error: unknown) => {
        dependencies.log.error('agent dispatch rejected outside its own boundary', {
          runId: created.id,
          error: describeThrown(error),
        })
      })

      return toRunView(created)
    },

    async getRun(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const run = await repository.findRun(dependencies.db, workspaceId, id)

      if (run === undefined) {
        throw AppError.notFound('Agent run not found')
      }

      return toRunView(run)
    },

    async listRuns(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, RUN_SORTS, DEFAULT_RUN_SORT)
      const runFilters: RunFilters = { agentId: filters.agentId, status: filters.status }
      const rows = await repository.listRuns(dependencies.db, workspaceId, runFilters, window)

      return mapPage(
        toPage(rows, window, (run) => run.id),
        toRunView,
      )
    },

    async listAgents(actor, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, AGENT_SORTS, DEFAULT_AGENT_SORT)
      const rows = await repository.listAgents(dependencies.db, workspaceId, window)

      return mapPage(
        toPage(rows, window, (agent) => agent.id),
        toAgentView,
      )
    },

    async getAgent(actor, id) {
      return toAgentView(await requireAgent(requireWorkspaceId(actor), id))
    },

    async createAgent(actor, input) {
      const workspaceId = requireAdminWorkspace(actor)

      const created = await dependencies.transaction(({ tx }) =>
        repository.insertAgent(tx, {
          id: dependencies.createId('agentRegistration'),
          workspaceId,
          name: input.name,
          endpoint: input.endpoint,
          authHeaderEncrypted:
            input.authHeader === undefined ? null : dependencies.cipher.seal(input.authHeader),
        }),
      )

      return toAgentView(created)
    },

    async updateAgent(actor, id, changes) {
      const workspaceId = requireAdminWorkspace(actor)
      const existing = await requireAgent(workspaceId, id)

      const columns: Partial<repository.AgentColumns> = {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.endpoint === undefined ? {} : { endpoint: changes.endpoint }),
      }

      // A re-sent header always writes: sealed values cannot be compared (each
      // seal spends a fresh IV), and re-saving a header is how a customer fixes
      // one sealed under a lost key.
      if (changes.authHeader !== undefined) {
        columns.authHeaderEncrypted =
          changes.authHeader === null ? null : dependencies.cipher.seal(changes.authHeader)
      }

      // A PATCH that changes nothing is not a write, the webhook rule.
      if (changes.authHeader === undefined && changedKeys(existing, columns).length === 0) {
        return toAgentView(existing)
      }

      const updated = await dependencies.transaction(async ({ tx }) => {
        const row = await repository.updateAgent(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (row === undefined) {
          throw AppError.notFound('Agent not found')
        }

        return row
      })

      return toAgentView(updated)
    },

    async removeAgent(actor, id) {
      const workspaceId = requireAdminWorkspace(actor)

      // The run log cascades with the registration, like a webhook's
      // deliveries: a run only means anything against the agent it went to.
      await dependencies.transaction(async ({ tx }) => {
        await requireAgent(workspaceId, id)
        await repository.deleteAgent(tx, workspaceId, id)
      })
    },
  }
}

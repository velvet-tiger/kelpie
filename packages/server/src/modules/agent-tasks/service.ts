import type { AgentRunStatus, AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'

import { requireApiKeyScope } from '../../lib/apiKeyScopes.ts'
import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { JobHandle } from '../../lib/jobs.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { SecretCipher } from '../../lib/secrets.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { roleAllows } from '../workspace/roles.ts'
import { AGENT_TASK_DEFINITIONS, findTask, tasksFor } from './catalog.ts'
import type { DispatchJobData } from './dispatch.ts'
import * as repository from './repository.ts'
import { AGENT_SORTS, DEFAULT_AGENT_SORT, DEFAULT_RUN_SORT, RUN_SORTS } from './repository.ts'
import type { AgentRecord, RunFilters, RunRecord } from './repository.ts'
import { runScopes, targetReadScope } from './scopes.ts'
import { buildTaskView } from './view.ts'
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
 *
 * A scoped API key needs more than `agent_tasks:write` to resolve and to run:
 * see `scopes.ts`.
 */

export interface AgentTasksDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly cipher: SecretCipher
  /** The `agent-tasks.dispatch` job, enqueued with the run it dispatches. */
  readonly dispatchJob: JobHandle<DispatchJobData>
}

/** An agent as the API returns one: never the header, never the tenancy column. */
export interface AgentView {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly hasAuthHeader: boolean
  /** The id of the module that owns this row, or null for one an admin registered. */
  readonly managedBy: string | null
  /** The UI route that configures a managed row, when its module has one. */
  readonly settingsPath: string | null
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
  /** Creates the run and its dispatch job in one transaction, and answers `queued`. */
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
    managedBy: record.managedBy,
    settingsPath: record.settingsPath,
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
    // existed.
    if (agent === undefined) {
      throw AppError.notFound('Agent not found')
    }

    return agent
  }

  /**
   * @throws AppError 409 for a row a module owns. The module writes it from its
   *   own settings; an edit here would drift from that module's state, and a
   *   removal would leave the module believing it is still registered.
   */
  function requireUnmanaged(agent: AgentRecord): void {
    if (agent.managedBy !== null) {
      throw AppError.conflict(
        `This agent is managed by the ${agent.managedBy} module; change it from that module's settings`,
      )
    }
  }

  async function resolveView(
    workspaceId: string,
    definition: AgentTaskDefinition,
    target: ResolveTargetInput,
  ): Promise<ResolvedTaskView> {
    const view = await buildTaskView(dependencies.db, workspaceId, definition, target)

    if (view === undefined) {
      throw AppError.notFound('Target record not found')
    }

    return view
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

      // Before the read, so a refused caller does not learn whether the
      // target exists.
      requireApiKeyScope(actor, targetReadScope(target.targetType))

      return resolveView(workspaceId, definition, target)
    },

    async run(actor, taskId, input) {
      const workspaceId = requireWorkspaceId(actor)
      const definition = requireTask(taskId)

      requireTargetType(definition, input.targetType)

      // The agent writes for the caller, with its own credential or as the
      // hosted AI, which has every scope. So the caller must hold the scopes
      // of what the run may write, or a key with `agent_tasks:write` alone
      // could change any record through an agent.
      for (const scope of runScopes(definition, input.targetType)) {
        requireApiKeyScope(actor, scope)
      }

      const agent = await requireAgent(workspaceId, input.agentId)

      // Resolved here only so a missing target answers 404 before a run
      // exists. The job resolves it again when it runs, and sends that.
      await resolveView(workspaceId, definition, input)

      const now = dependencies.now()

      const created = await dependencies.transaction(async ({ tx, jobs }) => {
        const run = await repository.insertRun(tx, {
          id: dependencies.createId('agentRun'),
          workspaceId,
          agentId: agent.id,
          taskId: definition.id,
          targetType: input.targetType,
          targetId: input.targetId,
          status: 'queued',
        })

        // `last_run_at` moves; `updated_at` does not. The latter answers "when
        // did somebody last change this registration", the webhook rule.
        await repository.updateAgent(tx, workspaceId, agent.id, { lastRunAt: now })

        // In the run's own transaction: a rollback leaves no job, and a
        // commit leaves a job, never a run that nothing will dispatch.
        // Grouped by workspace, so one workspace's runs cannot hold every
        // worker. The target type is the one the scopes above were checked for.
        await jobs.enqueue(
          dependencies.dispatchJob,
          { workspaceId, runId: run.id, targetType: input.targetType },
          { group: { id: workspaceId } },
        )

        return run
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
      requireUnmanaged(existing)

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
      } else if (changes.endpoint !== undefined && changes.endpoint !== existing.endpoint) {
        // The header was given for the old endpoint. Sent to a new one, it
        // would hand the credential to whoever changed the address, and the
        // API never returns it. So a new endpoint starts with no header unless
        // the same request gives one.
        columns.authHeaderEncrypted = null
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
        requireUnmanaged(await requireAgent(workspaceId, id))
        await repository.deleteAgent(tx, workspaceId, id)
      })
    },
  }
}

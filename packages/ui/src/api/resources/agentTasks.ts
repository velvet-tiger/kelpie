import {
  agentRunSchema,
  agentTaskDefinitionSchema,
  createRegisteredAgentBody,
  registeredAgentBody,
  registeredAgentSchema,
  resolveAgentTaskBody,
  resolvedAgentTaskSchema,
  runAgentTaskBody,
} from '@kelpie/schemas'
import type {
  AgentRun,
  AgentRunStatus,
  AgentTaskDefinition,
  AgentTaskTargetType,
  CreateRegisteredAgentInput,
  RegisteredAgent,
  RegisteredAgentInput,
  ResolveAgentTaskInput,
  ResolvedAgentTask,
  RunAgentTaskInput,
} from '@kelpie/schemas'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '../client.ts'
import { useApiClient } from '../context.ts'
import { toError } from '../errors.ts'
import { createReadOnlyResourceHooks, createResourceHooks } from '../resource.ts'
import type {
  ListOptions,
  MutationResult,
  RecordListResult,
  RecordResult,
  UpdateArguments,
} from '../resource.ts'
import { asMutationResult } from './mutation.ts'

/**
 * `/v1/agent-tasks`, `/v1/agent-runs` and `/v1/agents`: prompt recipes, their
 * dispatch log, and the bring-your-own agents they dispatch to.
 *
 * Resolve and run are POSTs with a task id in the path, so both are written out
 * the way `useCreateWebhook` is. A run settles on the server after the response
 * returns, which is what `useAgentRun`'s polling is for.
 */

const tasks = createReadOnlyResourceHooks<AgentTaskDefinition>({
  name: 'agent_tasks',
  path: '/agent-tasks',
  decode: agentTaskDefinitionSchema.parse,
})

/** The catalog for one target type. Code on the server, so never stale enough to refetch. */
export function useAgentTasks(targetType: AgentTaskTargetType): RecordListResult<AgentTaskDefinition> {
  return tasks.useList({ target_type: targetType })
}

/** The whole catalog, for labelling run-log rows by task id. */
export function useAllAgentTasks(): RecordListResult<AgentTaskDefinition> {
  return tasks.useList()
}

export interface ResolveAgentTaskArguments extends ResolveAgentTaskInput {
  readonly taskId: string
}

/** A POST in verb only: it assembles a prompt and writes nothing, so no cache moves. */
export function useResolveAgentTask(): MutationResult<ResolveAgentTaskArguments, ResolvedAgentTask> {
  const client = useApiClient()
  const mutation = useMutation({
    mutationFn: ({ taskId, ...input }: ResolveAgentTaskArguments) =>
      client.post(
        `/agent-tasks/${taskId}/resolve`,
        resolveAgentTaskBody(input),
        resolvedAgentTaskSchema.parse,
      ),
  })

  return asMutationResult(mutation)
}

export interface RunAgentTaskArguments extends RunAgentTaskInput {
  readonly taskId: string
}

export function useRunAgentTask(): MutationResult<RunAgentTaskArguments, AgentRun> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ taskId, ...input }: RunAgentTaskArguments) =>
      client.post(`/agent-tasks/${taskId}/run`, runAgentTaskBody(input), agentRunSchema.parse),
    onSettled: () => {
      // The run log gained a row, and the agent's `last_run_at` moved with it.
      void queryClient.invalidateQueries({ queryKey: ['agent_runs'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', 'list'] })
    },
  })

  return asMutationResult(mutation)
}

const runs = createReadOnlyResourceHooks<AgentRun>({
  name: 'agent_runs',
  path: '/agent-runs',
  decode: agentRunSchema.parse,
})

export interface AgentRunFilters {
  readonly agentId?: string
  readonly status?: AgentRunStatus
}

export function useAgentRuns(
  filters: AgentRunFilters = {},
  options: ListOptions = {},
): RecordListResult<AgentRun> {
  return runs.useList({ agent_id: filters.agentId, status: filters.status }, options)
}

const POLL_INTERVAL_MS = 750

/**
 * One run, polled while the dispatch is still moving. The server settles the
 * run after the create response returns, so `queued` and `running` are moments
 * the page would otherwise be stuck displaying forever.
 */
export function useAgentRun(id: string | undefined): RecordResult<AgentRun> {
  const client = useApiClient()
  const result = useQuery({
    // The same key `runs.useRecord` would use, so the two never hold different
    // copies of one run.
    queryKey: ['agent_runs', 'detail', id ?? ''],
    queryFn: () => client.get(`/agent-runs/${id ?? ''}`, agentRunSchema.parse),
    enabled: id !== undefined,
    refetchInterval: (query) => {
      const status = query.state.data?.status

      return status === 'queued' || status === 'running' ? POLL_INTERVAL_MS : false
    },
  })

  return {
    record: result.data,
    isLoading: result.isPending && id !== undefined,
    error: toError(result.error),
    isNotFound: result.error instanceof ApiError && result.error.status === 404,
  }
}

const agents = createResourceHooks<RegisteredAgent, CreateRegisteredAgentInput, RegisteredAgentInput>({
  name: 'agents',
  path: '/agents',
  decode: registeredAgentSchema.parse,
  createBody: createRegisteredAgentBody,
  updateBody: registeredAgentBody,
})

export function useAgents(options: ListOptions = {}): RecordListResult<RegisteredAgent> {
  return agents.useList({}, options)
}

export function useCreateAgent(): MutationResult<CreateRegisteredAgentInput, RegisteredAgent> {
  return agents.useCreate()
}

export function useUpdateAgent(): MutationResult<UpdateArguments<RegisteredAgentInput>, RegisteredAgent> {
  return agents.useUpdate()
}

export function useDeleteAgent(): MutationResult<string, void> {
  return agents.useRemove()
}

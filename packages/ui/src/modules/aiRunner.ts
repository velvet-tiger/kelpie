import { ApiError } from '../api/client.ts'
import { useAiRunForAgentRun, useAiSettings } from '../api/resources/ai.ts'
import { useAgents } from '../api/resources/agentTasks.ts'
import type { AgentRunner, AgentRunnerAvailability, AgentRunnerProgress } from '../registry/contributions.ts'

/** The `managed_by` value the server module writes on its agent row. */
const AI_MODULE_ID = 'ai'

/**
 * Kelpie AI as the Agent menu's runner.
 *
 * Ready only when the workspace can run a task now: the module answers (so it
 * is in the assembly and switched on), AI is enabled, a provider and key are
 * available (the workspace's own, or the deployment's), and the agent row the
 * module manages exists to dispatch to.
 */
function useAvailability(options: { readonly enabled: boolean }): AgentRunnerAvailability {
  const settings = useAiSettings({ enabled: options.enabled })
  const agents = useAgents({ enabled: options.enabled })

  if (settings.isLoading || agents.isLoading || !options.enabled) {
    return { status: 'loading' }
  }

  if (settings.error !== null) {
    // The runtime answers 403 or 404 when the module is switched off.
    return settings.error instanceof ApiError && (settings.error.status === 403 || settings.error.status === 404)
      ? { status: 'unavailable', reason: 'Kelpie AI is switched off for this workspace.' }
      : { status: 'unavailable', reason: 'Kelpie AI settings could not be read.' }
  }

  const record = settings.record

  if (record === undefined || !record.enabled) {
    return { status: 'unavailable', reason: 'Kelpie AI is not enabled. An admin can enable it under Admin → AI.' }
  }

  if (!record.configured) {
    return {
      status: 'unavailable',
      reason: 'Kelpie AI has no provider key. An admin can add one under Admin → AI.',
    }
  }

  const agent = agents.records.find((candidate) => candidate.managedBy === AI_MODULE_ID)

  if (agent === undefined) {
    return {
      status: 'unavailable',
      reason: 'The Kelpie AI agent is missing. An admin can save Admin → AI again to restore it.',
    }
  }

  return { status: 'ready', agentId: agent.id }
}

function useProgress(agentRunId: string | undefined): AgentRunnerProgress | undefined {
  const run = useAiRunForAgentRun(agentRunId)

  if (agentRunId === undefined) {
    return undefined
  }

  switch (run?.status) {
    case 'succeeded':
      return { status: 'succeeded' }
    case 'failed':
      return { status: 'failed', reason: run.failureReason ?? 'no reason recorded' }
    case 'queued':
    case 'running':
    case undefined:
      return { status: 'running' }
  }
}

export const aiRunner: AgentRunner = {
  id: AI_MODULE_ID,
  useAvailability,
  useProgress,
}

import { z } from 'zod'

import type { ModuleEventCatalog } from '../../runtime/module.ts'

/**
 * Domain events published by the agent-tasks module.
 *
 * `agent_tasks.run.settled` fires once a run ends, `succeeded` or `failed`,
 * from the one place that ends one: the dispatch engine's settle. It carries
 * ids and the status only, never the prompt, the failure reason, or record
 * content. A subscriber that needs more reads the run by its id.
 *
 * A run ends when its dispatch does. `succeeded` means the agent accepted the
 * task, not that it finished the work: core never hears back from an HTTP
 * agent. `managedBy` names the module that runs a managed agent. The `ai`
 * module reports the end of the work itself as `ai.run.settled`; that event's
 * `agentRunId` is this event's `runId`. Its own `runId` is a different id.
 *
 * No order between the two. The `ai` module starts its work detached, before
 * core's settle commits, so `ai.run.settled` can be published first.
 *
 * Not every run reports. A run that a process crash leaves at `running` never
 * settles, because nothing here sweeps stale runs. The bus's depth and cycle
 * guard can also drop the emit.
 *
 * The target is the run itself (`agent_run`). Webhooks do not deliver it: their
 * translator drops event names it does not know.
 */

export const agentTasksEvents = {
  'agent_tasks.run.settled': z.object({
    runId: z.string(),
    taskId: z.string(),
    agentId: z.string(),
    managedBy: z.string().nullable(),
    status: z.enum(['succeeded', 'failed']),
  }),
} satisfies ModuleEventCatalog

export interface AgentRunSettledData {
  readonly runId: string
  /** The catalog id of the task, for example `company.enrich`. */
  readonly taskId: string
  /** The agent registration the run was dispatched to. */
  readonly agentId: string
  /**
   * The id of the module that runs the agent, or null for an agent an admin
   * registered. When set, that module may report the end of the work itself.
   */
  readonly managedBy: string | null
  readonly status: 'succeeded' | 'failed'
}

declare module '../../runtime/events.ts' {
  interface KelpieEventMap {
    'agent_tasks.run.settled': AgentRunSettledData
  }
}

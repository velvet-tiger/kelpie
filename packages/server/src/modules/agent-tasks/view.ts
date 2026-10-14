import type { AgentTaskDefinition, AgentTaskTargetType } from '@kelpie/schemas'

import type { Queryable } from '../../runtime/transaction.ts'
import { renderBasePrompt, renderExternalAgentPrompt } from './prompt.ts'
import { assemblePromptInputs } from './resolve.ts'
import type { ResolvedTaskView } from './wire.ts'

/**
 * The resolved view of one task on one target: the prompt in both framings
 * and the ids of the context it read.
 *
 * Shared by resolve, which answers it, and by the dispatch job, which builds
 * it again when the run starts rather than carry it in the queue. The view
 * holds CRM data and the prompt, and `pgboss.job` is not where those belong.
 */

export interface TaskTarget {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
}

/**
 * @returns The view, or undefined when the target is not a record of this
 *   workspace.
 */
export async function buildTaskView(
  db: Queryable,
  workspaceId: string,
  definition: AgentTaskDefinition,
  target: TaskTarget,
): Promise<ResolvedTaskView | undefined> {
  const inputs = await assemblePromptInputs(db, workspaceId, definition, target.targetType, target.targetId)

  if (inputs === undefined) {
    return undefined
  }

  return {
    taskId: definition.id,
    targetType: target.targetType,
    targetId: target.targetId,
    prompt: renderExternalAgentPrompt(definition, target.targetType, target.targetId, inputs),
    basePrompt: renderBasePrompt(definition, target.targetType, target.targetId, inputs),
    context: {
      targetLabel: inputs.targetLabel,
      deepLink: inputs.deepLink,
      handbookSlugs: inputs.handbookPages.map((page) => page.slug),
      pinnedNoteIds: inputs.pinnedNoteIds,
      openPlanIds: inputs.openPlanIds,
      openDecisionIds: inputs.openDecisionIds,
      proposedDecisionIds: inputs.proposedDecisionIds,
      related: Object.fromEntries(
        Object.entries(inputs.related)
          .filter(([, list]) => list.ids.length > 0)
          .map(([key, list]) => [key, list.ids]),
      ),
    },
  }
}

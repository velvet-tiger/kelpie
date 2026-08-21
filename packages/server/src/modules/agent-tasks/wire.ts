import type { AgentTaskTargetType } from '@kelpie/schemas'

/**
 * The resolved-task wire shape, in its own file because it has two consumers:
 * the resolve route renders it as a response, and the dispatch engine POSTs it
 * to a registered agent. One renderer is what keeps Copy and Run identical,
 * which `agent-tasks.md` makes the whole point of resolve.
 */

export interface ContextPackView {
  readonly targetLabel: string
  readonly deepLink: string
  readonly handbookSlugs: readonly string[]
  readonly pinnedNoteIds: readonly string[]
  readonly openPlanIds: readonly string[]
  readonly openDecisionIds: readonly string[]
  readonly related: Readonly<Record<string, readonly string[]>>
}

export interface ResolvedTaskView {
  readonly taskId: string
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  /**
   * The external-agent-framed prompt: opens with "operating via MCP / the
   * public API", ends with "Done when… applied allowed updates". This is
   * what Copy hands to a user and what a customer agent reads.
   */
  readonly prompt: string
  /**
   * The shared body without the framing. What an agent that returns
   * structured data (the hosted AI is the one that ships) reads before
   * adding its own instructions.
   */
  readonly basePrompt: string
  readonly context: ContextPackView
}

export function resolvedTaskResponse(resolved: ResolvedTaskView): Record<string, unknown> {
  return {
    task_id: resolved.taskId,
    target_type: resolved.targetType,
    target_id: resolved.targetId,
    prompt: resolved.prompt,
    base_prompt: resolved.basePrompt,
    context: {
      target_label: resolved.context.targetLabel,
      deep_link: resolved.context.deepLink,
      handbook_slugs: resolved.context.handbookSlugs,
      pinned_note_ids: resolved.context.pinnedNoteIds,
      open_plan_ids: resolved.context.openPlanIds,
      open_decision_ids: resolved.context.openDecisionIds,
      related: resolved.context.related,
    },
  }
}

/**
 * What a registered agent receives. The resolved task plus two fields the
 * receiver cannot infer: which run this is (the dedupe key, like a webhook's
 * delivery id) and which workspace it belongs to (a receiver holds no
 * credential context, and two workspaces can share one endpoint).
 */
export function dispatchPayload(
  run: { readonly id: string; readonly workspaceId: string },
  resolved: ResolvedTaskView,
): Record<string, unknown> {
  return {
    run_id: run.id,
    workspace_id: run.workspaceId,
    ...resolvedTaskResponse(resolved),
  }
}

import { z } from 'zod'

import { AppError } from '../../lib/errors.ts'
import type { AgentDispatchOutcome, AgentDispatcher } from '../../runtime/module.ts'
import type { AiService, DispatchContext } from './service.ts'

/**
 * The in-process dispatcher core's agent-tasks engine calls for the "Kelpie
 * AI" row (`managed_by = 'ai'`).
 *
 * The payload is the object core would POST to an agent's endpoint, so it is
 * parsed like a request body. It never crosses the network, which is why there
 * is no dispatch URL and no per-workspace secret: only core's engine can call
 * this, for a run an authenticated member started in that workspace.
 *
 * The body is `z.object` rather than `z.strictObject`: core may add fields to
 * its dispatch payload in a minor release, and dispatch should not start
 * failing runs over that. The `context` bag inside is permissive too.
 *
 * An `AppError` from the service (AI not enabled, no key, over the monthly
 * limit) becomes a failed outcome with its message, which core records on the
 * visible agent run. Anything else is rethrown for the engine to log.
 */

const contextBody = z
  .object({
    target_label: z.string().optional(),
    deep_link: z.string().optional(),
    handbook_slugs: z.array(z.string()).optional(),
    pinned_note_ids: z.array(z.string()).optional(),
    open_plan_ids: z.array(z.string()).optional(),
    open_decision_ids: z.array(z.string()).optional(),
    /** Buckets like `person_ids`, `company_ids`. */
    related: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough()

const dispatchBody = z.object({
  run_id: z.string().min(1),
  workspace_id: z.string().min(1),
  task_id: z.string().min(1),
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  /** The external-agent-framed prompt. Used only when `base_prompt` is absent. */
  prompt: z.string().min(1),
  /**
   * The general request without the external-agent framing. The module adds
   * its own structured-output instructions on top of this.
   */
  base_prompt: z.string().min(1).optional(),
  /** Persisted with the run row: the executor reads the target's neighbours from these ids. */
  context: contextBody.optional(),
})

const ACCEPTED: AgentDispatchOutcome = { delivered: true, status: 202, reason: null }

export function createAiDispatcher(service: AiService): AgentDispatcher {
  return async (payload) => {
    const parsed = dispatchBody.safeParse(payload)

    if (!parsed.success) {
      return {
        delivered: false,
        status: 422,
        reason: `The dispatch payload is not valid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      }
    }

    try {
      await service.accept({
        runId: parsed.data.run_id,
        workspaceId: parsed.data.workspace_id,
        taskId: parsed.data.task_id,
        targetType: parsed.data.target_type,
        targetId: parsed.data.target_id,
        // Prefer `base_prompt`: it does not carry the "apply via MCP/API"
        // framing the model must ignore.
        prompt: parsed.data.base_prompt ?? parsed.data.prompt,
        context: (parsed.data.context ?? {}) as DispatchContext,
      })
    } catch (thrown: unknown) {
      if (thrown instanceof AppError) {
        return { delivered: false, status: thrown.status, reason: thrown.message }
      }
      throw thrown
    }

    return ACCEPTED
  }
}

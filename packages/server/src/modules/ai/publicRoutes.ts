import { AppError } from '../../lib/errors.ts'
import type { Hono } from 'hono'
import { z } from 'zod'

import type { AiService, DispatchContext } from './service.ts'

/**
 * `/v1/public/ai/dispatch`.
 *
 * Registered through `context.publicRoutes` because core's dispatch engine
 * carries no session cookie and no bearer key of its own: the workspace-scoped
 * secret in the `Authorization` header is the credential, verified in
 * `service.intake` with a constant-time compare. Same posture as
 * `modules/billing/publicRoutes.ts` and Stripe's signature header.
 *
 * The body is `z.object` rather than `z.strictObject`: core may add fields to
 * its dispatch payload in a minor release, and the intake should not start
 * failing runs over that. The `context` bag inside is also permissive — the
 * shape mirrors core's `agent-tasks/wire.ts` today, but if core widens it,
 * unknown keys pass through and land on the run row.
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
  /**
   * The external-agent-framed prompt from core. Every dispatch carries this;
   * the cloud AI prefers `base_prompt` when it is present but falls back to
   * this so the module works against an older core that never sent one.
   */
  prompt: z.string().min(1),
  /**
   * The general request without the external-agent framing. When present,
   * the cloud AI adds its own structured-output instructions on top rather
   * than wrapping around the MCP/API language in `prompt`. Optional so a
   * dispatch from an older core still lands.
   */
  base_prompt: z.string().min(1).optional(),
  /**
   * The context pack from core. Persisted with the run row so the executor
   * — which may claim this row long after the intake returned — has the
   * ids it needs to read the target and its neighbours.
   */
  context: contextBody.optional(),
})

export function mountAiPublicRoutes(router: Hono, service: AiService): void {
  router.post('/ai/dispatch', async (context) => {
    let raw: unknown
    try {
      raw = await context.req.json()
    } catch {
      throw new AppError('bad_request', 'Body must be JSON')
    }

    const parsed = dispatchBody.safeParse(raw)

    if (!parsed.success) {
      throw AppError.validationFailed(
        'The dispatch payload is not valid',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      )
    }

    await service.intake(
      {
        runId: parsed.data.run_id,
        workspaceId: parsed.data.workspace_id,
        taskId: parsed.data.task_id,
        targetType: parsed.data.target_type,
        targetId: parsed.data.target_id,
        // Prefer `base_prompt` — it does not carry the "apply via MCP/API"
        // framing the cloud AI must ignore. Fall back to `prompt` when core
        // predates the split so an older deployment still runs.
        prompt: parsed.data.base_prompt ?? parsed.data.prompt,
        context: (parsed.data.context ?? {}) as DispatchContext,
      },
      context.req.header('authorization'),
    )

    // 202: the row is queued or running; the executor works after this
    // response returns. Core's dispatch timeout is 10 s so answering fast
    // matters, and every slow step is behind `executor.pump`'s `void`.
    return context.body(null, 202)
  })
}

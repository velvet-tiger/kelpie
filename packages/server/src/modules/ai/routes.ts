import { AI_PROVIDERS } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import { pageBody, readListParameters } from '../../lib/http.ts'
import { resolveActorFrom } from '../auth/credentials.ts'
import type { CredentialDependencies } from '../auth/credentials.ts'
import { referenceResponse } from '../recordReferences.ts'
import type { AiRunView, AiService, AiSettingsChanges, AiSettingsView } from './service.ts'

/**
 * `/v1/ai/settings` and `/v1/ai/runs`.
 *
 * Public API like every other endpoint: the admin AI page in the UI calls
 * these through the same client an agent would. The module is toggleable, so
 * the runtime auto-gates these routes behind the `module.ai` capability — this
 * file resolves the actor and the service applies its own role check for the
 * two admin verbs.
 */

/**
 * The settings body. Every field is optional, and an absent body is an empty
 * one, so a `deployment`-mode client posts nothing, as it always has. Strict,
 * so a misspelt `apikey` fails loudly instead of being ignored.
 */
const settingsInput = z.strictObject({
  provider: z.enum(AI_PROVIDERS).optional(),
  api_key: z.string().trim().min(1).max(500).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  web_search: z.boolean().optional(),
})

async function readSettingsChanges(context: Context): Promise<AiSettingsChanges> {
  const text = await context.req.text()
  let raw: unknown = {}

  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      throw new AppError('bad_request', 'Body must be JSON')
    }
  }

  const parsed = settingsInput.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('The AI settings are not valid', toErrorDetails(parsed.error.issues))
  }

  return {
    ...(parsed.data.provider === undefined ? {} : { provider: parsed.data.provider }),
    ...(parsed.data.api_key === undefined ? {} : { apiKey: parsed.data.api_key }),
    ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
    ...(parsed.data.web_search === undefined ? {} : { webSearch: parsed.data.web_search }),
  }
}

export interface AiRoutesDependencies extends CredentialDependencies {
  readonly service: AiService
}

function settingsBody(view: AiSettingsView): Record<string, unknown> {
  return {
    service: view.service,
    key_mode: view.keyMode,
    configured: view.configured,
    enabled: view.enabled,
    provider: view.provider,
    model: view.model,
    key_source: view.keySource,
    key_hint: view.keyHint,
    monthly_limit: view.monthlyLimit,
    runs_this_month: view.runsThisMonth,
    web_search: view.webSearch,
  }
}

function runBody(run: AiRunView): Record<string, unknown> {
  return {
    id: run.id,
    agent_run_id: run.agentRunId,
    task_id: run.taskId,
    target_type: run.targetType,
    target_id: run.targetId,
    target_name: run.targetName,
    status: run.status,
    model: run.model,
    operations:
      run.operations?.map((operation) => ({
        kind: operation.kind,
        status: operation.status,
        detail: operation.detail,
        references: operation.references.map(referenceResponse),
      })) ?? null,
    failure_reason: run.failureReason,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
  }
}

export function mountAiRoutes(router: Hono, dependencies: AiRoutesDependencies): void {
  router.get('/ai/settings', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const view = await dependencies.service.view(actor)

    return context.json(settingsBody(view))
  })

  // POST rather than PUT for the enable/save/repair verb: the UI's ApiClient
  // exposes `post`/`delete`/`get` and not `put`, and re-posting rewrites the
  // registration row idempotently. The body carries the workspace's provider,
  // key and model in `workspace` key mode, and is empty otherwise.
  router.post('/ai/settings', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const changes = await readSettingsChanges(context)
    const view = await dependencies.service.enable(actor, changes)

    return context.json(settingsBody(view))
  })

  router.delete('/ai/settings', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    await dependencies.service.disable(actor)

    return context.body(null, 204)
  })

  router.get('/ai/runs', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const page = await dependencies.service.listRuns(actor, readListParameters(context))

    return context.json(pageBody(page, runBody))
  })

  router.get('/ai/runs/:id', async (context) => {
    const actor = await resolveActorFrom(dependencies, context)
    const id = context.req.param('id')

    if (id === undefined) {
      throw AppError.notFound('No AI run has that id')
    }

    const run = await dependencies.service.getRun(actor, id)

    return context.json(runBody(run))
  })
}

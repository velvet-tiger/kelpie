import { fileURLToPath } from 'node:url'

import { AI_PROVIDERS } from '@kelpie/schemas'
import type { AiKeyMode, AiProvider, AiService as AiServiceName } from '@kelpie/schemas'
import { z } from 'zod'

import { createSecretCipher, secretEncryptionConfigSchema } from '../../lib/secrets.ts'
import type { KelpieModule, McpTool } from '../../runtime/module.ts'
import { createAnthropicPort } from './anthropic.ts'
import { createAiCredentialResolver } from './credentials.ts'
import { createAiDispatcher } from './dispatch.ts'
import { aiEvents } from './events.ts'
import { createAiExecutor } from './executor.ts'
import type { AiPortResolution } from './executor.ts'
import { createAiRunIdFactory } from './ids.ts'
import { createPersonIntake } from './intake.ts'
import { mountPersonIntakeRoutes } from './intakeRoutes.ts'
import type { IdFactory } from './ids.ts'
import { createOpenAiPort } from './openai.ts'
import type { AiProviderPort } from './provider.ts'
import { findSettings } from './repository.ts'
import { mountAiRoutes } from './routes.ts'
import {
  AI_RUNS_LIMIT,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_RUN_LOG_LIMIT,
  DEFAULT_RUN_TIMEOUT_MINUTES,
} from './rules.ts'
import * as schema from './schema.ts'
import { createAiService } from './service.ts'
import { createAiRunSettler } from './settle.ts'

/**
 * Kelpie AI: an agent that runs agent tasks with a model provider.
 *
 * **Optional, and not in `coreModules`.** An assembly adds `createAiModule()`
 * to its module list when it wants the agent. Core bundles the code; nothing
 * runs, and no table exists, until an assembly lists it.
 *
 * Registers a "Kelpie AI" agent in the workspace's `agent_registrations` when
 * an admin enables it, so the agent shows up in the Run dialog on every
 * record page. Core's agent-tasks engine hands the resolved task to the
 * dispatcher this module provides (`context.agentDispatch`), in-process: no
 * URL and no secret. The dispatcher queues the run and detaches the executor,
 * which builds a context pack by reading the relevant records itself, calls
 * the provider with **no tools** and a JSON reply shape, then validates the
 * reply and applies the operations it contains through the in-process MCP
 * tool registry with a synthetic actor. The model never sees a tool.
 *
 * **Key modes.** `workspace` (the default): an admin chooses OpenAI or
 * Anthropic, enters their own API key, and may pick a model; `AI_PROVIDER`,
 * `AI_API_KEY` and `AI_MODEL` are the deployment's fallback. `deployment`:
 * the environment is the only source and the workspace cannot change it,
 * which is what a hosted deployment that pays for the model runs.
 *
 * **Person intake.** `/v1/ai/person-intake/*` identifies a person from
 * pasted notes, researches them, and writes the records the user ticks. The
 * two model calls are synchronous runs, metered like queued ones, and are
 * the only place the model gets a tool: the provider's own web search, when
 * the workspace's `web_search` setting allows it (`intake.ts`).
 *
 * **Limits.** The module declares `ai.runs.limit`. With no provider for it in
 * the assembly it answers unlimited. A hosted assembly answers it from its
 * plan catalog and names that module in `requires`.
 *
 * **Toggleable, not structural.** The runtime gates `/v1/ai/*` behind
 * `module.ai`. The dispatcher is not gated, so in-flight dispatches from
 * before a switch-off do not fail on the toggle.
 *
 * **No durable queue.** A crash mid-turn leaves a row `running`; the next
 * dispatch's stale sweep marks it failed and the user re-runs. Consistent with
 * `import-export` and `webhooks`.
 */

/**
 * The module's own migration directory. The tables are only created in an
 * assembly that lists the module, so they cannot live in core's shared
 * pipeline. Same depth from `src/` and `dist/`.
 */
export const aiMigrationsDirectory = fileURLToPath(new URL('../../../module-migrations/ai/', import.meta.url))

const optionalText = z.string().trim().min(1).optional()

/**
 * `AI_PROVIDER` and `AI_API_KEY` are optional: a deployment without them
 * still boots. In `workspace` mode they are a fallback, and in `deployment`
 * mode their absence means settings cannot be enabled and dispatch refuses,
 * both with a message the operator can act on.
 */
const configSchema = z.object({
  AI_PROVIDER: z.enum(AI_PROVIDERS).optional(),
  AI_API_KEY: optionalText,
  AI_MODEL: optionalText,
  AI_MAX_TOKENS: z.coerce.number().int().min(1024).max(128_000).default(DEFAULT_MAX_OUTPUT_TOKENS),
  AI_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(20).default(DEFAULT_MAX_CONCURRENT_RUNS),
  AI_RUN_TIMEOUT_MINUTES: z.coerce.number().int().positive().max(240).default(DEFAULT_RUN_TIMEOUT_MINUTES),
  AI_RUN_LOG_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_RUN_LOG_LIMIT),
})

export type AiProviderFactory = (options: { readonly apiKey: string }) => AiProviderPort

export interface AiModuleOptions {
  /**
   * Which AI service this install offers. Defaults to `custom`, the
   * workspace's own provider. Kelpie Cloud passes `kelpie_ai`. Independent of
   * `keyMode`: a self-hosted install may one day offer Kelpie AI too.
   */
  readonly service?: AiServiceName
  /** Defaults to `workspace`. A hosted assembly passes `deployment`. */
  readonly keyMode?: AiKeyMode
  /**
   * Extra module ids this assembly requires, for example the module that
   * answers `ai.runs.limit`. Naming it makes a missing limit a boot failure
   * rather than silent unlimited use of the operator's key.
   */
  readonly requires?: readonly string[]
  /**
   * Injected so tests hand in fakes without a provider account. Defaults to
   * the SDK adapters in `openai.ts` and `anthropic.ts`.
   */
  readonly providers?: Partial<Record<AiProvider, AiProviderFactory>>
  /** Injected so a test can pin an `ai_<ulid>` id. Production passes nothing. */
  readonly createRunId?: IdFactory
  /**
   * Injected so a test can observe or stub the tools the executor calls.
   * Production passes nothing and the executor reads `context.mcp.list()`.
   */
  readonly tools?: () => readonly McpTool[]
}

const DEFAULT_PROVIDERS: Readonly<Record<AiProvider, AiProviderFactory>> = {
  openai: (options) => createOpenAiPort(options),
  anthropic: (options) => createAnthropicPort(options),
}

export function createAiModule(options: AiModuleOptions = {}): KelpieModule {
  const keyMode = options.keyMode ?? 'workspace'
  const providers: Readonly<Record<AiProvider, AiProviderFactory>> = {
    ...DEFAULT_PROVIDERS,
    ...options.providers,
  }
  const createRunId = options.createRunId ?? createAiRunIdFactory()

  return {
    // Naming `agent-tasks` in `requires` makes an assembly missing the
    // dispatch surface fail at boot rather than register an agent nothing
    // will ever call.
    id: 'ai',
    events: aiEvents,
    requires: ['workspace', 'agent-tasks', ...(options.requires ?? [])],

    register(context) {
      const config = context.config(configSchema)
      const cipher = createSecretCipher(context.secretEncryption ?? context.config(secretEncryptionConfigSchema))
      const environment = {
        provider: config.AI_PROVIDER,
        apiKey: config.AI_API_KEY,
        model: config.AI_MODEL,
      }

      if (environment.apiKey !== undefined && environment.provider === undefined) {
        // A key with no provider is never used. Say so at boot rather than
        // leave an operator wondering why the fallback does nothing.
        context.log.warn('AI_API_KEY is set without AI_PROVIDER; the key is ignored', {})
      }
      if (keyMode === 'deployment' && (environment.provider === undefined || environment.apiKey === undefined)) {
        // Not an error: the deployment chose not to enable AI. The module
        // still registers so the UI can tell the admin cleanly.
        context.log.info('ai module registered without AI_PROVIDER and AI_API_KEY; enable and dispatch are disabled', {})
      }

      const credentials = createAiCredentialResolver({ keyMode, environment, cipher, log: context.log })

      // One port per key, reused across runs. A workspace that changes its
      // key gets a new entry; the old one is dropped with the next change.
      const ports = new Map<string, { readonly apiKey: string; readonly port: AiProviderPort }>()

      async function resolvePort(workspaceId: string): Promise<AiPortResolution> {
        const settings = await findSettings(context.db, workspaceId)
        const resolved = credentials.forRow(settings)

        if (resolved.problem !== null) {
          return { kind: 'unavailable', reason: resolved.problem }
        }
        if (resolved.provider === null || resolved.apiKey === null) {
          return { kind: 'unavailable', reason: 'AI has no provider and key for this workspace any more' }
        }

        const cacheKey = `${workspaceId}:${resolved.provider}`
        const cached = ports.get(cacheKey)
        if (cached !== undefined && cached.apiKey === resolved.apiKey) {
          return { kind: 'ready', port: cached.port }
        }

        const port = providers[resolved.provider]({ apiKey: resolved.apiKey })
        ports.set(cacheKey, { apiKey: resolved.apiKey, port })
        return { kind: 'ready', port }
      }

      const settler = createAiRunSettler({ transaction: context.transaction, now: context.now })

      const executor = createAiExecutor({
        db: context.db,
        settler,
        resolvePort,
        // Read at run time: the list is complete only after boot.
        listTools: options.tools ?? (() => context.mcp.list()),
        exposeProviderErrors: keyMode === 'workspace',
        now: context.now,
        maxTokens: config.AI_MAX_TOKENS,
        maxConcurrentRuns: config.AI_MAX_CONCURRENT_RUNS,
        log: context.log,
      })
      const service = createAiService({
        db: context.db,
        transaction: context.transaction,
        settler,
        cipher,
        credentials,
        serviceName: options.service ?? 'custom',
        keyMode,
        coreCreateId: context.createId,
        createRunId,
        entitlements: context.entitlements,
        executor,
        now: context.now,
        runTimeoutMinutes: config.AI_RUN_TIMEOUT_MINUTES,
        runLogLimit: config.AI_RUN_LOG_LIMIT,
        log: context.log,
      })

      const intake = createPersonIntake({
        service,
        resolvePort,
        listTools: options.tools ?? (() => context.mcp.list()),
        maxTokens: config.AI_MAX_TOKENS,
        exposeProviderErrors: keyMode === 'workspace',
        log: context.log,
      })

      context.schema(schema, aiMigrationsDirectory)
      context.entitlements.declare(AI_RUNS_LIMIT)

      context.routes((router) => {
        mountAiRoutes(router, { db: context.db, now: context.now, service })
        mountPersonIntakeRoutes(router, { db: context.db, now: context.now, intake })
      })

      context.agentDispatch.provide(createAiDispatcher(service))

      // Handler runs after the emitting transaction commits and must be
      // idempotent: at-least-once delivery, and `deleteRuns`/`deleteSettings`
      // are no-ops on absent rows. Core's `agent_registrations` cascades with
      // the workspace so no cleanup for that side is needed here.
      context.events.subscribe('workspace.workspace.deleted', async (event) => {
        await service.forget(event.workspaceId)
      })

      return Promise.resolve()
    },
  }
}

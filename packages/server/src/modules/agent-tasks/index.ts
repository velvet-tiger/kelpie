import { createSecretCipher, secretEncryptionConfigSchema } from '../../lib/secrets.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { createDispatchEngine, createHttpSender } from './dispatch.ts'
import type { SendDispatch } from './dispatch.ts'
import { mountAgentTasksRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createAgentTasksService } from './service.ts'

/**
 * Agent tasks (`agent-tasks.md`): the task catalog, resolve, run dispatch, and
 * registered agents.
 *
 * `requires` names every module whose tables resolve reads — the dashboard
 * rule. Nothing here depends on registration order; the list is about a build
 * that omits one of them, which should fail at boot rather than answer resolve
 * with a query against an unmigrated table.
 */
export interface AgentTasksModuleOptions {
  /** Injected by tests so no suite makes a network call. */
  readonly send?: SendDispatch
}

export function createAgentTasksModule(
  migrationsDirectory: string,
  options: AgentTasksModuleOptions = {},
): KelpieModule {
  return {
    id: 'agent-tasks',
    requires: [
      'workspace',
      'people',
      'companies',
      'positions',
      'pipelines',
      'deals',
      'opportunities',
      'partnerships',
      'raises',
      'hiring',
      'plans',
      'decisions',
      'notes',
      'handbook',
    ],

    register(context) {
      // Validated at boot rather than on the first run: a missing or malformed
      // key means no stored auth header can ever be read back, and finding that
      // out when a dispatch quietly fails is far too late.
      const cipher = createSecretCipher(context.config(secretEncryptionConfigSchema))

      const engine = createDispatchEngine({
        db: context.db,
        now: context.now,
        cipher,
        send: options.send ?? createHttpSender(),
        log: context.log,
      })

      const service = createAgentTasksService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        cipher,
        engine,
        log: context.log,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountAgentTasksRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

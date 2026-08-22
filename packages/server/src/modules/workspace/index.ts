import { appUrlConfigSchema } from '../../lib/appUrl.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import { parseModuleCapability } from '../../runtime/moduleConfig.ts'
import { SEATS_LIMIT, WORKSPACE_ACCESS } from './capabilities.ts'
import { workspaceEvents } from './events.ts'
import * as repository from './repository.ts'
import { mountWorkspaceRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createWorkspaceService } from './service.ts'
import { registerWorkspaceTools } from './tools.ts'

/**
 * Workspaces, membership, and invites.
 *
 * Requires `auth`: `workspace_members.user_id` references `users`, and every
 * route here resolves an actor from a session.
 */
export function createWorkspaceModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'workspace',
    requires: ['auth'],
    structural: true,
    events: workspaceEvents,

    register(context) {
      // Prefer the top-level `appBaseUrl` from the assembly's kelpie.config.ts;
      // fall back to the schema read for older assemblies that don't declare it.
      const appBaseUrl = context.appBaseUrl ?? context.config(appUrlConfigSchema).APP_BASE_URL

      context.entitlements.declare(SEATS_LIMIT)
      context.entitlements.declare(WORKSPACE_ACCESS)

      // Answers `module.<id>` for whatever a config override left undecided
      // (`runtime/registry.ts` registers that provider first, ahead of this
      // one, so a locked value never reaches this query).
      context.entitlements.provide(async (workspaceId, capability) => {
        const moduleId = parseModuleCapability(capability.name)

        if (moduleId === undefined) {
          return undefined
        }

        const setting = await repository.findModuleSetting(context.db, workspaceId, moduleId)

        return setting === undefined ? undefined : { kind: 'flag', granted: setting.enabled }
      })

      const service = createWorkspaceService({
        db: context.db,
        transaction: context.transaction,
        email: context.email,
        createId: context.createId,
        now: context.now,
        entitlements: context.entitlements,
        appBaseUrl,
        toggleableModuleIds: context.moduleCatalog
          .filter((entry) => !entry.structural)
          .map((entry) => entry.id),
        moduleConfigOverrides: context.moduleConfig,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountWorkspaceRoutes(router, { db: context.db, now: context.now, service })
      })

      registerWorkspaceTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

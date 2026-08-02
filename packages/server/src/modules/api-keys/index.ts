import type { KelpieModule } from '../../runtime/module.ts'
import { mountApiKeyRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createApiKeyService } from './service.ts'

/**
 * Workspace and personal API keys.
 *
 * Every key is bound to one workspace at creation, so there is no workspace
 * header and no workspace path segment anywhere in the API.
 */
export function createApiKeysModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'api-keys',
    requires: ['workspace'],

    register(context) {
      const service = createApiKeyService({
        db: context.db,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountApiKeyRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

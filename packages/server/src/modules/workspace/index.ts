import type { KelpieModule } from '../../runtime/module.ts'
import { mountWorkspaceRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createWorkspaceService } from './service.ts'

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

    register(context) {
      const service = createWorkspaceService({
        db: context.db,
        transaction: context.transaction,
        email: context.email,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)
      context.webhookEvents(['workspace.created', 'member.invited', 'member.joined'])

      context.routes((router) => {
        mountWorkspaceRoutes(router, { db: context.db, now: context.now, service })
      })

      return Promise.resolve()
    },
  }
}

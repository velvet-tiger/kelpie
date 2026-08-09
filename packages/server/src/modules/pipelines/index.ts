import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { mountPipelinesRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createPipelineStagesService } from './service.ts'
import { registerPipelineTools } from './tools.ts'

/**
 * Pipeline stage configuration: the board columns of the four pipelines.
 *
 * Requires `activities`, because remove-with-reassign writes each displaced
 * record's `stage_changed` timeline entry in the same transaction.
 */
export function createPipelinesModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'pipelines',
    requires: ['workspace', 'activities'],
    structural: true,

    register(context) {
      const service = createPipelineStagesService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity: createActivityRecorder({
          createId: context.createId,
          now: context.now,
        }),
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountPipelinesRoutes(router, { db: context.db, now: context.now, service })
      })

      registerPipelineTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { importExportEvents } from './events.ts'
import { mountImportExportRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createImportExportService } from './service.ts'
import { registerImportExportTools } from './tools.ts'

/**
 * Import and export: CSV in and out.
 *
 * It requires every object it writes, and `pipelines` because a deal row names a
 * stage by slug and has to resolve it against this workspace's own board.
 * `activities` is the timeline entry each imported record carries, written in
 * the same transaction as the record itself.
 *
 * The five import and export MCP tools (`tools.ts`) call these same services,
 * so an agent on `POST /mcp` and a client on the REST routes get one behaviour.
 */
export function createImportExportModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'import-export',
    requires: ['people', 'companies', 'positions', 'pipelines', 'deals', 'activities'],
    events: importExportEvents,

    register(context) {
      const service = createImportExportService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity: createActivityRecorder({
          createId: context.createId,
          now: context.now,
        }),
        log: context.log,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountImportExportRoutes(router, { db: context.db, now: context.now, service })
      })

      registerImportExportTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

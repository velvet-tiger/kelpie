import type { KelpieModule } from '../../runtime/module.ts'
import { createActivityRecorder } from '../activities/index.ts'
import { createCandidatesService } from './candidates.ts'
import { createRolesService } from './roles.ts'
import { mountHiringRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { registerHiringTools } from './tools.ts'

/**
 * Hiring: the roles a workspace is filling, and the people up for them.
 *
 * Two resources rather than one, because they have different lives. A Role
 * outlives the candidacies on it, and a Candidate is the link that carries the
 * pipeline state — a shape Person cannot hold, since one person can be in
 * process for one role and in the nurture pile for another.
 *
 * Requires `people` because both ends of a candidacy are checked against the
 * caller's workspace before it is linked, and `activities` because every write
 * leaves its entry on the person's timeline in the same transaction.
 */
export function createHiringModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'hiring',
    requires: ['people', 'activities'],

    register(context) {
      const recordActivity = createActivityRecorder({
        createId: context.createId,
        now: context.now,
      })
      const services = {
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
        recordActivity,
      }

      context.schema(schema, migrationsDirectory)

      const hiring = {
        roles: createRolesService(services),
        candidates: createCandidatesService(services),
      }

      context.routes((router) => {
        mountHiringRoutes(router, { db: context.db, now: context.now, ...hiring })
      })

      registerHiringTools(context.mcp, hiring)

      return Promise.resolve()
    },
  }
}

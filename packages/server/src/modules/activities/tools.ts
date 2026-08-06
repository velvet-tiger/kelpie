import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, listWindowShape, pageResult, toListQuery } from '../crudTools.ts'
import { activityResponse } from './routes.ts'
import type { ActivitiesService } from './service.ts'

/**
 * `activities_list`, and nothing else.
 *
 * Activity is written by the services that cause it, inside their own
 * transaction. There is no REST endpoint that writes one, so there is no tool
 * that does either.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  target_type: z.enum(RECORD_TARGET_TYPES).describe('The kind of record whose timeline to read.'),
  target_id: idArg.describe('The record whose timeline to read.'),
})

export function registerActivitiesTools(mcp: McpToolRegistry, service: ActivitiesService): void {
  mcp.tool({
    name: 'activities_list',
    description:
      'Read one record\'s timeline: what changed, who changed it, and when. Always names ' +
      'a record; there is no workspace-wide feed. Cursor paged. Mirrors GET /v1/activities.',
    inputSchema: listArgs,
    invoke: async (args, actor) =>
      pageResult(
        await service.list(
          actor,
          { targetType: args.target_type, targetId: args.target_id },
          toListQuery(args),
        ),
        activityResponse,
      ),
  })
}

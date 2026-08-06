import { z } from 'zod'

import { MAX_PAGE_SIZE } from '../../lib/pagination.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { dashboardResponse } from './routes.ts'
import type { DashboardService } from './service.ts'

/**
 * `dashboard_get`, and nothing else. The resource is read-only, so there is no
 * tool that writes one.
 *
 * This is the tool the `workspace.*` tasks in `agent-tasks.md` read from: a
 * daily brief, a stale-relationship triage and a pipeline review all start from
 * the same snapshot, and each of them would otherwise open with several list
 * calls and a client-side join to name the records.
 */
const getArgs = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe('How many rows each embedded list carries. The totals beside them are exact.'),
})

export function registerDashboardTools(mcp: McpToolRegistry, service: DashboardService): void {
  mcp.tool({
    name: 'dashboard_get',
    description:
      'Read the workspace snapshot: open counts per pipeline, overdue and due-soon plan items, ' +
      'partnership touchpoints at hand, contacts going cold, and the latest activity, notes and ' +
      'decisions. Each attention signal carries an exact total beside a capped list, and every ' +
      'cross-record row names the record it is about. Mirrors GET /v1/dashboard.',
    inputSchema: getArgs,
    invoke: async (args, actor) =>
      dashboardResponse(await service.snapshot(actor, args.limit)),
  })
}

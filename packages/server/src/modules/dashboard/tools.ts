import { z } from 'zod'

import { MAX_PAGE_SIZE } from '../../lib/pagination.ts'
import type { McpToolRegistry } from '../../runtime/module.ts'
import { STALE_CONTACT_DAYS, UPCOMING_DAYS } from './attention.ts'
import { dashboardResponse } from './routes.ts'
import type { DashboardService } from './service.ts'

/**
 * `dashboard_get`, and nothing else. The resource is read-only, so there is no
 * tool that writes one.
 *
 * This is the tool the `workspace.*` tasks in `docs/agents/agent-tasks.md` read
 * from: a
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

/**
 * The tool's description. The two windows are read from the same constants the
 * snapshot uses, so the text cannot drift from the numbers in the response.
 */
export const DASHBOARD_GET_DESCRIPTION =
  'Read the workspace snapshot: open counts per pipeline, overdue and due-soon plan items, ' +
  'partnership touchpoints at hand, contacts going cold, and the latest activity, notes and ' +
  'decisions. Each attention signal carries an exact total beside a capped list, and every ' +
  'cross-record row names the record it is about. Mirrors GET /v1/dashboard. ' +
  `A stale contact has gone ${STALE_CONTACT_DAYS} days without contact. Plan items and ` +
  `partnership touchpoints are due soon within ${UPCOMING_DAYS} days. Both windows are fixed. ` +
  'The response echoes them as stale_contact_days and upcoming_days.'

export function registerDashboardTools(mcp: McpToolRegistry, service: DashboardService): void {
  mcp.tool({
    name: 'dashboard_get',
    description: DASHBOARD_GET_DESCRIPTION,
    scope: 'dashboard:read',
    inputSchema: getArgs,
    invoke: async (args, actor) =>
      dashboardResponse(await service.snapshot(actor, args.limit)),
  })
}

import { mcpToolSchema } from '@kelpie/schemas'
import type { McpTool } from '@kelpie/schemas'

import { createReadOnlyResourceHooks } from '../resource.ts'
import type { RecordListResult } from '../resource.ts'

/**
 * `/v1/mcp/tools`, read-only: what this deployment exposes over MCP.
 *
 * Read rather than hard-coded, because the tool set is whatever the modules in
 * this assembly registered. A cloud install with extra modules exposes more than
 * an open-source one, and a list written into the page would be wrong for both
 * the moment somebody added a resource.
 */

const tools = createReadOnlyResourceHooks<McpTool>({
  name: 'mcp_tools',
  path: '/mcp/tools',
  decode: mcpToolSchema.parse,
})

/**
 * The whole set in one request. It is fixed at boot, not paged, and answers
 * `next_cursor: null` however many tools there are.
 */
export function useMcpTools(): RecordListResult<McpTool> {
  return tools.useList()
}

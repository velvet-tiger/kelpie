import { z } from 'zod'

/**
 * Wire shape for `GET /v1/mcp/tools`: what this deployment exposes over MCP.
 *
 * The same listing an MCP client gets from `tools/list`, read with ordinary
 * credentials. A browser cannot call `/mcp` — it takes bearer keys only — so
 * this is how the admin page shows what is actually registered rather than a
 * hand-written copy that drifts.
 */

export interface McpTool {
  /** `people_list`, `handbook_pages_get`, `import_commit`. Resource, then verb. */
  readonly name: string
  readonly description: string
  /** JSON Schema for the tool's arguments, as the MCP client sees it. */
  readonly inputSchema: Record<string, unknown>
}

export const mcpToolSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .transform(
    (wire): McpTool => ({
      name: wire.name,
      description: wire.description,
      inputSchema: wire.input_schema,
    }),
  )

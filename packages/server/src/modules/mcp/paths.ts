/**
 * Where the MCP transport mounts.
 *
 * A file of its own so `modules/auth/credentials.ts` can tell an `/mcp`
 * request from a `/v1` one without importing the router, which imports
 * credentials.
 */
export const MCP_ROUTE_PREFIX = '/mcp'

/** True for the MCP transport itself, the one surface an OAuth token reaches. */
export function isMcpPath(path: string): boolean {
  return path === MCP_ROUTE_PREFIX || path.startsWith(`${MCP_ROUTE_PREFIX}/`)
}

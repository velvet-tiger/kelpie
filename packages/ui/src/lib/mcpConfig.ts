/**
 * How an MCP client reaches this workspace.
 *
 * The endpoint comes from the origin the browser reached the app on, so it is
 * right for a self-hosted install on any hostname. The MCP page shows the config
 * with a placeholder token; a freshly minted API key shows it with the real one.
 */

export function mcpEndpoint(): string {
  return new URL('/mcp', window.location.origin).toString()
}

export function mcpClientConfig(endpoint: string, bearerToken: string): string {
  return `{
  "mcpServers": {
    "kelpie": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer ${bearerToken}"
      }
    }
  }
}`
}

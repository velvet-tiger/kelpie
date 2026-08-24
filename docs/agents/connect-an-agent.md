# Connect an agent

Point Claude, Cursor, or any MCP client at a Kelpie workspace. Every operation the app offers is also an MCP tool over Streamable HTTP, so a connected agent reads and writes the same records your team does — through the same API, with the same refusals.

The **Admin → MCP** page in your Kelpie shows the live version of everything here: your exact endpoint URL, a ready-made config snippet, and the current tool catalog (110 tools at the time of writing, and modules can extend it — trust the page, not this number).

## Step 1: create an API key

MCP takes bearer API keys only. A browser session will not work, deliberately.

- **Workspace key** (`kp_live_…`) — create it at **Admin → API keys** (admin only). It acts for the workspace. Right for a shared agent, an automation, or CI.
- **Personal key** (`kp_user_…`) — create it at **Account → API keys**. It acts as you. Right for the agent on your own machine.

Either kind is shown once; copy it when it appears. A key is bound to one workspace — connecting a second workspace means a second key.

## Step 2: the endpoint

```
https://your-kelpie.example.com/mcp
```

Same origin as the app, path `/mcp`. On a local install that is `http://localhost:5173/mcp` (the dev server proxies it through).

## Claude Code

```bash
claude mcp add kelpie --transport http https://your-kelpie.example.com/mcp --header "Authorization: Bearer kp_live_…"
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "kelpie": {
      "type": "http",
      "url": "https://your-kelpie.example.com/mcp",
      "headers": { "Authorization": "Bearer kp_live_…" }
    }
  }
}
```

## Claude Desktop

Add the same `mcpServers` block to the desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Cursor

Add the block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in one project.

## Any other MCP client

The generic shape is the one Admin → MCP generates for you:

```json
{
  "mcpServers": {
    "kelpie": {
      "url": "https://your-kelpie.example.com/mcp",
      "headers": {
        "Authorization": "Bearer kp_live_…"
      }
    }
  }
}
```

Client authors: the endpoint speaks the current MCP revision and the two `initialize`-based revisions before it; protocol detail is in the [API reference](../api-reference.md).

## Remote installs, proxies, and TLS

The client machine must reach the deployment — an agent on your laptop cannot see a Kelpie bound to an office network it is not on. Behind a reverse proxy nothing extra is needed; the endpoint lives on the same origin as the app. A self-signed certificate will fail most clients' TLS verification, so use a real certificate or keep agent and Kelpie on the same host over plain localhost HTTP.

## Check it works

Ask the client to list tools; the same catalog is on Admin → MCP, and `GET /v1/mcp/tools` returns it over ordinary credentials. Then ask the agent something real: "list the people in my CRM".

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` | Missing, mistyped, or revoked key — or a session cookie instead of a bearer key. |
| `403` | The request carried a browser `Origin` that is not the deployment's own; MCP refuses cross-origin browsers outright. |
| "entitlement required" on one tool | That module is switched off at Admin → Modules (or locked off by the operator). |
| A tool "fails" with a validation message | Working as intended: tools refuse exactly what the API refuses, with the same message, and the agent is meant to read it and adjust. |

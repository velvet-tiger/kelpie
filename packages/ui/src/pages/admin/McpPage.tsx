import type { McpTool } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useMcpTools } from '../../api/resources/mcpTools.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'

/**
 * How an agent connects to this workspace.
 *
 * Everything on the page is derived rather than written down. The endpoint comes
 * from the origin the browser reached the app on, the same way a form's embed URL
 * does, so it is right for a self-hosted install on any hostname. The tool list
 * comes from `/v1/mcp/tools`, which reads the registry the endpoint itself
 * dispatches against: a module that adds a resource shows up here without anyone
 * editing this file.
 *
 * The mockup also listed registered agents and their run log. That belongs to
 * agent tasks, which is a separate feature, and is not ported here.
 */

/**
 * Matches a tool on its name or its description, so "csv" finds the import and
 * export tools and "pinned" finds the note list that filters on it.
 */
function matches(tool: McpTool, term: string): boolean {
  const needle = term.trim().toLowerCase()

  if (needle.length === 0) {
    return true
  }

  return (
    tool.name.toLowerCase().includes(needle) ||
    tool.description.toLowerCase().includes(needle)
  )
}

export function McpPage(): React.JSX.Element {
  const endpoint = new URL('/mcp', window.location.origin).toString()
  const config = `{
  "mcpServers": {
    "kelpie": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer kp_live_…"
      }
    }
  }
}`

  return (
    <div className="animate-slide-in mx-auto max-w-4xl space-y-6">
      <PageHeader title="MCP" description="Connect agents to this workspace over Streamable HTTP." />

      <section className="rounded-md border border-border p-5">
        <h2 className="text-[15px] font-semibold text-ink">How agents use Kelpie</h2>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
          Kelpie is a CRM and a company brain. Every REST operation is also an MCP tool over
          Streamable HTTP, so an agent reads and writes the same records the app does, through the
          same API. Point Claude, Cursor, or any MCP client at this workspace. There is no bundled
          AI: bring your own agent.
        </p>
        <ul className="mt-4 space-y-2 text-[13px] text-ink">
          <li className="flex gap-2">
            <span className="text-accent">→</span>
            An API key is bound to one workspace, so a client sees that workspace and no other.
          </li>
          <li className="flex gap-2">
            <span className="text-accent">→</span>
            A tool refuses exactly what the endpoint behind it refuses, with the same message.
          </li>
          <li className="flex gap-2">
            <span className="text-accent">→</span>
            Signing in with a browser session does not work here. The endpoint takes bearer keys
            only.
          </li>
        </ul>
      </section>

      <section className="rounded-md border border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-ink">Streamable HTTP endpoint</h2>
          <CopyButton value={endpoint} label="Copy the endpoint URL" />
        </div>
        <code className="mt-3 block rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-[13px] break-all text-ink">
          {endpoint}
        </code>
      </section>

      <section className="rounded-md border border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-ink">Claude / Cursor config</h2>
          <CopyButton value={config} label="Copy the client config" />
        </div>
        <p className="mt-1 text-[12px] text-ink-muted">
          Paste into your MCP client config, and replace the bearer token with a workspace key from{' '}
          <Link to="/admin/workspace" className="text-accent hover:underline">
            workspace settings
          </Link>
          .
        </p>
        <pre className="bg-code-bg text-code-fg mt-3 overflow-x-auto rounded-md border border-border p-4 font-mono text-[12px] leading-relaxed">
          {config}
        </pre>
      </section>

      <ToolCatalog />
    </div>
  )
}

/**
 * What this deployment actually registered, read from the endpoint's own registry.
 *
 * A flat list rather than a grouped one. Tool names are resource-then-verb, so
 * sorting by name already puts a resource's five together, and every rule for
 * grouping them turned out to be a lexical guess that read `webhooks_rotate_secret`
 * as a resource called `webhooks_rotate`.
 */
function ToolCatalog(): React.JSX.Element {
  const { records, isLoading, error } = useMcpTools()
  const [term, setTerm] = useState('')
  const shown = useMemo(
    () => [...records].filter((tool) => matches(tool, term)).sort((left, right) => left.name.localeCompare(right.name)),
    [records, term],
  )

  return (
    <section className="rounded-md border border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">Tools</h2>
        {records.length > 0 && (
          <input
            type="search"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value)
            }}
            placeholder="Filter tools"
            aria-label="Filter tools"
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-ink outline-none focus:border-border-strong"
          />
        )}
      </div>
      <p className="mt-1 max-w-2xl text-[12px] text-ink-muted">
        {isLoading
          ? 'Reading what this deployment exposes.'
          : `${String(records.length)} tools, mirroring the REST API one for one. Arguments and results are snake_case JSON.`}
      </p>

      {error !== null && <div className="mt-4">{<ErrorPanel error={error} />}</div>}
      {isLoading && <LoadingPanel label="Loading tools…" />}

      {records.length > 0 && shown.length === 0 && (
        <p className="mt-4 text-[12px] text-ink-faint">No tool matches “{term}”.</p>
      )}

      {shown.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {shown.map((tool) => (
            <li key={tool.name} className="px-3 py-2.5">
              <code className="font-mono text-[12px] text-accent">{tool.name}</code>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{tool.description}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

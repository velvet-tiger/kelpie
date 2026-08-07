import { AGENT_RUN_STATUS_LABELS } from '@kelpie/schemas'
import type { AgentRun, McpTool } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import {
  useAgentRuns,
  useAgents,
  useAllAgentTasks,
  useCreateAgent,
  useDeleteAgent,
} from '../../api/resources/agentTasks.ts'
import { useMcpTools } from '../../api/resources/mcpTools.ts'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'
import { formatRelativeTime } from '../../lib/dates.ts'

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
 * Registered agents and their run log live here too, under the connection
 * details, where the mockup put them: an agent is something you connect, and
 * this is the connections page.
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

      <RegisteredAgents />
      <RecentRuns />
      <ToolCatalog />
    </div>
  )
}

/**
 * Bring-your-own agents that Run dispatches to. Any member reads this list —
 * the Run dialog on every record page is built from it — and the API holds
 * writes to admins, so a member's Add answers `403` and the form shows it.
 */
function RegisteredAgents(): React.JSX.Element {
  const { records, isLoading, error } = useAgents()
  const createAgent = useCreateAgent()
  const deleteAgent = useDeleteAgent()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [authHeader, setAuthHeader] = useState('')

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    createAgent
      .runAsync({
        name,
        endpoint,
        ...(authHeader.trim().length === 0 ? {} : { authHeader }),
      })
      .then(() => {
        setAdding(false)
        setName('')
        setEndpoint('')
        setAuthHeader('')
      })
      .catch(() => {
        // The form stays open and renders `createAgent.error`.
      })
  }

  return (
    <section className="rounded-md border border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-ink">Registered agents</h2>
        <button
          type="button"
          onClick={() => {
            setAdding((open) => !open)
          }}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink transition hover:border-accent hover:text-accent"
        >
          {adding ? 'Cancel' : 'Add agent'}
        </button>
      </div>
      <p className="mt-1 max-w-2xl text-[12px] text-ink-muted">
        Run on any record dispatches the resolved task to one of these endpoints as JSON. The agent
        still reads and writes through the API above. The auth header is stored encrypted and never
        shown again.
      </p>

      {adding && (
        <form onSubmit={submit} className="mt-4 space-y-2 rounded-md border border-border p-3">
          <label className="block text-[12px] text-ink-muted">
            Name
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              required
              placeholder="Local Claude"
              className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block text-[12px] text-ink-muted">
            Endpoint URL
            <input
              value={endpoint}
              onChange={(event) => {
                setEndpoint(event.target.value)
              }}
              required
              placeholder="https://agents.example.com/kelpie/run"
              className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="block text-[12px] text-ink-muted">
            Auth header (optional, sent as Authorization)
            <input
              value={authHeader}
              onChange={(event) => {
                setAuthHeader(event.target.value)
              }}
              placeholder="Bearer …"
              className="mt-1 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={createAgent.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              Register agent
            </button>
            {createAgent.error !== null && (
              <span className="text-[12px] text-danger">{createAgent.error.message}</span>
            )}
          </div>
        </form>
      )}

      {error !== null && <div className="mt-4">{<ErrorPanel error={error} />}</div>}
      {isLoading && <LoadingPanel label="Loading agents…" />}

      {!isLoading && error === null && records.length === 0 && (
        <p className="mt-4 text-[12px] text-ink-faint">
          No agents registered. Copy prompt works without one; Run needs somewhere to send the task.
        </p>
      )}

      {records.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {records.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{agent.name}</div>
                <code className="font-mono text-[11px] break-all text-ink-muted">
                  {agent.endpoint}
                </code>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] text-ink-faint">
                {agent.hasAuthHeader && <span>Auth header set</span>}
                <span>
                  {agent.lastRunAt === null
                    ? 'Never run'
                    : `Last run ${formatRelativeTime(agent.lastRunAt)}`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    deleteAgent.run(agent.id)
                  }}
                  className="font-medium text-danger hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {deleteAgent.error !== null && (
        <p className="mt-2 text-[12px] text-danger">{deleteAgent.error.message}</p>
      )}
    </section>
  )
}

const RUN_LOG_ROWS = 8

/** The newest dispatches, labelled from the catalog the tasks came from. */
function RecentRuns(): React.JSX.Element {
  const { records: runs, isLoading, error } = useAgentRuns()
  const catalog = useAllAgentTasks()
  const agents = useAgents()

  const taskLabels = useMemo(
    () => new Map(catalog.records.map((task) => [task.id, task.label])),
    [catalog.records],
  )
  const agentNames = useMemo(
    () => new Map(agents.records.map((agent) => [agent.id, agent.name])),
    [agents.records],
  )

  function describeRun(run: AgentRun): string {
    const agentName = agentNames.get(run.agentId) ?? 'a removed agent'

    return `${run.targetType}/${run.targetId} → ${agentName}`
  }

  return (
    <section className="rounded-md border border-border p-5">
      <h2 className="text-[13px] font-semibold text-ink">Recent runs</h2>
      <p className="mt-1 text-[12px] text-ink-muted">
        Each run records the dispatch: queued, then succeeded or failed with the reason. What the
        agent did afterwards is on the records themselves.
      </p>

      {error !== null && <div className="mt-4">{<ErrorPanel error={error} />}</div>}
      {isLoading && <LoadingPanel label="Loading runs…" />}

      {!isLoading && error === null && runs.length === 0 && (
        <p className="mt-4 text-[12px] text-ink-faint">
          No runs yet. Run an agent task from any record page.
        </p>
      )}

      {runs.length > 0 && (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {runs.slice(0, RUN_LOG_ROWS).map((run) => (
            <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">
                  {taskLabels.get(run.taskId) ?? run.taskId}
                </div>
                <div className="text-[11px] text-ink-muted">{describeRun(run)}</div>
                {run.failureReason !== null && (
                  <div className="text-[11px] text-danger">{run.failureReason}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px]">
                <span className={run.status === 'failed' ? 'font-medium text-danger' : 'text-ink-muted'}>
                  {AGENT_RUN_STATUS_LABELS[run.status]}
                </span>
                <span className="text-ink-faint">{formatRelativeTime(run.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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

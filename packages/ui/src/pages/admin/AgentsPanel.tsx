import { AGENT_RUN_STATUS_LABELS } from '@kelpie/schemas'
import type { AgentRun } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useTimezone } from '../../api/resources/account.ts'
import {
  useAgentRuns,
  useAgents,
  useAllAgentTasks,
  useCreateAgent,
  useDeleteAgent,
} from '../../api/resources/agentTasks.ts'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatRelativeTime } from '../../lib/dates.ts'

/**
 * The Agents tab on Admin → AI: the bring-your-own agents that Run dispatches
 * to, and the log of those dispatches.
 *
 * Core, so every install has it. It sits under Admin because registering an
 * agent is configuration and the API holds the writes to admins. How a client
 * connects over MCP is not configuration, and is on the AI page at `/ai`.
 */
export function AgentsPanel(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <RegisteredAgents />
      <RecentRuns />
    </div>
  )
}

/**
 * Bring-your-own agents that Run dispatches to. Any member can read this list
 * through the API (the Run dialog on every record page is built from it), and
 * the API holds writes to admins.
 */
function RegisteredAgents(): React.JSX.Element {
  const { records, isLoading, error } = useAgents()
  const createAgent = useCreateAgent()
  const deleteAgent = useDeleteAgent()
  const timezone = useTimezone()
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
        still reads and writes through the public API. The auth header is stored encrypted and never
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
                {agent.managedBy === null ? (
                  <code className="font-mono text-[11px] break-all text-ink-muted">
                    {agent.endpoint}
                  </code>
                ) : (
                  // A module-managed agent is dispatched in-process; its stored
                  // endpoint is not an address anything calls.
                  <span className="text-[11px] text-ink-muted">Runs inside Kelpie ({agent.managedBy} module)</span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] text-ink-faint">
                {agent.hasAuthHeader && <span>Auth header set</span>}
                <span>
                  {agent.lastRunAt === null
                    ? 'Never run'
                    : `Last run ${formatRelativeTime(agent.lastRunAt, timezone)}`}
                </span>
                {agent.managedBy === null ? (
                  <button
                    type="button"
                    onClick={() => {
                      deleteAgent.run(agent.id)
                    }}
                    className="font-medium text-danger hover:underline"
                  >
                    Remove
                  </button>
                ) : agent.settingsPath === null ? (
                  // The API refuses to change a row a module owns, so there is
                  // no Remove to offer; the module's own settings manage it.
                  <span>Managed by a module</span>
                ) : (
                  <Link to={agent.settingsPath} className="font-medium text-accent hover:underline">
                    Manage in settings
                  </Link>
                )}
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
  const timezone = useTimezone()

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
                <span className="text-ink-faint">{formatRelativeTime(run.updatedAt, timezone)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

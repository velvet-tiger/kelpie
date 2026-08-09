import { useEffect, useId, useRef, useState } from 'react'
import type { AgentRun, AgentTaskDefinition, AgentTaskTargetType, ResolvedAgentTask } from '@kelpie/schemas'

import {
  useAgentRun,
  useAgents,
  useAgentTasks,
  useResolveAgentTask,
  useRunAgentTask,
} from '../api/resources/agentTasks.ts'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'

/**
 * The Agent menu on a record: every task for its target type, each with Copy
 * prompt, Preview, and Run. Ported from the mockup with the in-memory resolve
 * swapped for `POST …/resolve` and the pretend status ladder swapped for the
 * run record the server settles, polled until it does.
 */
export interface AgentTasksProps {
  readonly targetType: AgentTaskTargetType
  readonly targetId: string
  readonly targetLabel: string
  /** Smaller trigger for dense rows (e.g. candidates). */
  readonly compact?: boolean
}

type PanelMode = 'preview' | 'run' | null

const COPIED_MS = 1800

export function AgentTasks({
  targetType,
  targetId,
  targetLabel,
  compact = false,
}: AgentTasksProps): React.JSX.Element | null {
  const catalog = useAgentTasks(targetType)
  const resolve = useResolveAgentTask()
  const dispatch = useRunAgentTask()
  const [menuOpen, setMenuOpen] = useState(false)
  const [panel, setPanel] = useState<PanelMode>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [resolved, setResolved] = useState<ResolvedAgentTask | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Fetched only once the run pane opens: the trigger sits on every detail
  // page, and most visits never dispatch anything.
  const agents = useAgents({ enabled: panel === 'run' })
  const { record: run } = useAgentRun(runId ?? undefined)

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    function onDocumentMouseDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', onDocumentMouseDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    setPanel(null)
    setActiveTaskId(null)
    setResolved(null)
    setRunId(null)
    setMenuOpen(false)
  }, [targetType, targetId])

  useEffect(() => {
    if (agentId === '' && agents.records.length > 0) {
      setAgentId(agents.records[0]?.id ?? '')
    }
  }, [agentId, agents.records])

  const primary = catalog.records.filter((task) => task.placement === 'primary')
  const overflow = catalog.records.filter((task) => task.placement === 'overflow')

  if (!catalog.isLoading && catalog.error === null && catalog.records.length === 0) {
    return null
  }

  function openResolved(taskId: string, mode: PanelMode): void {
    setActiveTaskId(taskId)
    setResolved(null)
    setRunId(null)
    setPanel(mode)
    setMenuOpen(false)
    resolve
      .runAsync({ taskId, targetType, targetId })
      .then(setResolved)
      .catch(() => {
        // The dialog stays open and renders `resolve.error` with a retry.
      })
  }

  async function copyPrompt(taskId: string): Promise<void> {
    try {
      const next =
        resolved !== null && activeTaskId === taskId
          ? resolved
          : await resolve.runAsync({ taskId, targetType, targetId })

      await navigator.clipboard.writeText(next.prompt)
      setCopiedId(taskId)
      window.setTimeout(() => {
        setCopiedId(null)
      }, COPIED_MS)
    } catch {
      // Resolve failed or the clipboard is unavailable; the dialog shows which.
      openResolved(taskId, 'preview')
    }
  }

  function startRun(): void {
    if (activeTaskId === null || agentId === '') {
      return
    }

    dispatch
      .runAsync({ taskId: activeTaskId, targetType, targetId, agentId })
      .then((created) => {
        setRunId(created.id)
      })
      .catch(() => {
        // The dialog renders `dispatch.error` beside the button.
      })
  }

  const activeTask = catalog.records.find((task) => task.id === activeTaskId)
  const settled = run?.status === 'succeeded' || run?.status === 'failed'
  const dispatching = dispatch.isPending || (run !== undefined && !settled)

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => {
          setMenuOpen((open) => !open)
        }}
        className={
          compact
            ? 'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:border-accent hover:text-accent'
            : // Sized to sit beside `DeleteRecord`'s trigger, not the mockup's
              // heavier header button.
              'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink-muted transition hover:border-accent hover:text-accent'
        }
      >
        Agent
        <ChevronDown open={menuOpen} />
      </button>

      {menuOpen && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-1 w-[min(100vw-2rem,320px)] overflow-hidden rounded-md border border-border bg-surface-raised py-1"
        >
          {catalog.isLoading && <LoadingPanel label="Loading tasks…" />}
          {catalog.error !== null && <ErrorPanel error={catalog.error} />}
          {primary.length > 0 && (
            <TaskGroup
              label="Actions"
              tasks={primary}
              copiedId={copiedId}
              onCopy={(id) => void copyPrompt(id)}
              onPreview={(id) => {
                openResolved(id, 'preview')
              }}
              onRun={(id) => {
                openResolved(id, 'run')
              }}
            />
          )}
          {overflow.length > 0 && (
            <TaskGroup
              label={primary.length > 0 ? 'More' : 'Actions'}
              tasks={overflow}
              copiedId={copiedId}
              bordered={primary.length > 0}
              onCopy={(id) => void copyPrompt(id)}
              onPreview={(id) => {
                openResolved(id, 'preview')
              }}
              onRun={(id) => {
                openResolved(id, 'run')
              }}
            />
          )}
        </div>
      )}

      {panel !== null && activeTask !== undefined && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-ink/30 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={activeTask.label}
          onClick={() => {
            setPanel(null)
          }}
        >
          <div
            className="max-h-[85vh] w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-[14px] font-semibold text-ink">{activeTask.label}</div>
                <div className="mt-0.5 text-[12px] text-ink-muted">
                  {targetLabel} · {panel === 'run' ? 'Run' : 'Preview prompt'}
                </div>
              </div>
              <button
                type="button"
                className="text-[12px] font-medium text-ink-muted hover:text-ink"
                onClick={() => {
                  setPanel(null)
                }}
              >
                Close
              </button>
            </div>

            <div className="max-h-[50vh] overflow-y-auto px-4 py-3">
              {resolved === null && resolve.isPending && <LoadingPanel label="Resolving…" />}
              {resolved === null && !resolve.isPending && resolve.error !== null && (
                <ErrorPanel
                  error={resolve.error}
                  onRetry={() => {
                    openResolved(activeTask.id, panel)
                  }}
                />
              )}
              {resolved !== null && (
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink">
                  {resolved.prompt}
                </pre>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
                disabled={resolved === null}
                onClick={() => void copyPrompt(activeTask.id)}
              >
                {copiedId === activeTask.id ? 'Copied' : 'Copy prompt'}
              </button>
              {panel === 'preview' && (
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:border-accent"
                  onClick={() => {
                    setPanel('run')
                  }}
                >
                  Run…
                </button>
              )}
              {panel === 'run' && (
                <RunControls
                  agents={agents.records}
                  agentsLoading={agents.isLoading}
                  agentId={agentId}
                  onAgentChange={setAgentId}
                  run={run}
                  dispatching={dispatching}
                  dispatchError={dispatch.error}
                  disabled={resolved === null}
                  onDispatch={startRun}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function runButtonLabel(run: AgentRun | undefined): string {
  switch (run?.status) {
    case 'queued':
      return 'Queued…'
    case 'running':
      return 'Running…'
    case 'succeeded':
      return 'Run again'
    case 'failed':
      return 'Retry run'
    case undefined:
      return 'Dispatch run'
  }
}

function RunControls({
  agents,
  agentsLoading,
  agentId,
  onAgentChange,
  run,
  dispatching,
  dispatchError,
  disabled,
  onDispatch,
}: {
  readonly agents: readonly { readonly id: string; readonly name: string }[]
  readonly agentsLoading: boolean
  readonly agentId: string
  readonly onAgentChange: (id: string) => void
  readonly run: AgentRun | undefined
  readonly dispatching: boolean
  readonly dispatchError: Error | null
  readonly disabled: boolean
  readonly onDispatch: () => void
}): React.JSX.Element {
  if (!agentsLoading && agents.length === 0) {
    return (
      <span className="text-[11px] text-ink-muted">
        No agents are registered. An admin can add one under Admin → MCP.
      </span>
    )
  }

  return (
    <>
      <label className="flex items-center gap-2 text-[12px] text-ink-muted">
        Agent
        <select
          value={agentId}
          onChange={(event) => {
            onAgentChange(event.target.value)
          }}
          className="rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:border-accent disabled:opacity-50"
        disabled={disabled || dispatching || agentId === ''}
        onClick={onDispatch}
      >
        {runButtonLabel(run)}
      </button>
      {run !== undefined && (
        <span className="text-[11px] text-ink-muted">
          {run.status === 'succeeded' && 'Dispatched. The agent works through the API from here.'}
          {run.status === 'failed' && `Dispatch failed: ${run.failureReason ?? 'no reason recorded'}`}
          {(run.status === 'queued' || run.status === 'running') && `Status: ${run.status}`}
        </span>
      )}
      {dispatchError !== null && (
        <span className="text-[11px] text-danger">{dispatchError.message}</span>
      )}
    </>
  )
}

function TaskGroup({
  label,
  tasks,
  copiedId,
  bordered = false,
  onCopy,
  onPreview,
  onRun,
}: {
  readonly label: string
  readonly tasks: readonly AgentTaskDefinition[]
  readonly copiedId: string | null
  readonly bordered?: boolean
  readonly onCopy: (id: string) => void
  readonly onPreview: (id: string) => void
  readonly onRun: (id: string) => void
}): React.JSX.Element {
  return (
    <div className={bordered ? 'border-t border-border pt-1' : undefined}>
      <div className="px-3 py-1.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </div>
      <ul>
        {tasks.map((task) => (
          <li key={task.id} role="menuitem" className="px-3 py-2 hover:bg-surface">
            <div className="text-[13px] font-medium text-ink">{task.label}</div>
            <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{task.description}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-ink-muted transition hover:border-accent hover:text-accent"
                onClick={() => {
                  onCopy(task.id)
                }}
              >
                {copiedId === task.id ? 'Copied' : 'Copy prompt'}
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-ink-muted transition hover:border-accent hover:text-accent"
                onClick={() => {
                  onPreview(task.id)
                }}
              >
                Preview
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-ink-muted transition hover:border-accent hover:text-accent"
                onClick={() => {
                  onRun(task.id)
                }}
              >
                Run
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChevronDown({ open }: { readonly open: boolean }): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={open ? 'rotate-180 text-ink-muted transition' : 'text-ink-muted transition'}
    >
      <path
        d="M3 4.5L6 7.5L9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

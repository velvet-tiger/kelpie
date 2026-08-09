import type { Dashboard } from '@kelpie/schemas'

import { useDashboard } from '../../api/resources/dashboard.ts'
import { useMembers } from '../../api/resources/members.ts'
import { useWorkspace } from '../../api/resources/workspace.ts'
import { AgentTasks } from '../../components/AgentTasks.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { attentionRows, briefLines } from './attention.ts'
import { ActivityFeed, AttentionList, DecisionsList, NotesList } from './sections.tsx'

/**
 * The workspace home: what is open, what is late, and what happened lately.
 *
 * One request, not seven. `GET /v1/dashboard` answers the whole page, with the
 * name of every record it points at already resolved, so this file holds no
 * fetching beyond the two directories the shell needs anyway — the workspace,
 * for its name, and the team, to turn an author id into a person.
 */

/** The heading date, written in the workspace's own day rather than the browser's. */
function briefHeading(dashboard: Dashboard): string {
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: dashboard.timezone,
  }).format(dashboard.generatedAt)
}

export function DashboardPage(): React.JSX.Element {
  const { dashboard, isLoading, error } = useDashboard()
  const { workspace } = useWorkspace()
  const { nameById } = useMembers()

  return (
    <div className="animate-fade-in">
      <PageHeader title="Dashboard" description="What needs attention across this workspace." />

      {error !== null && <ErrorPanel error={error} />}
      {isLoading && <LoadingPanel label="Loading the workspace…" />}

      {dashboard !== undefined && (
        <DashboardBody
          dashboard={dashboard}
          workspaceId={workspace?.id}
          workspaceName={workspace?.name ?? 'This workspace'}
          nameById={nameById}
        />
      )}
    </div>
  )
}

function DashboardBody({
  dashboard,
  workspaceId,
  workspaceName,
  nameById,
}: {
  readonly dashboard: Dashboard
  readonly workspaceId: string | undefined
  readonly workspaceName: string
  readonly nameById: ReadonlyMap<string, string>
}): React.JSX.Element {
  // `generatedAt` rather than a fresh `new Date()`: every relative time on the
  // page is then measured from the same instant the counts were, so a tab left
  // open does not creep towards "2 hours ago" on rows that never moved.
  const now = dashboard.generatedAt

  return (
    <div>
      <section className="mb-8 border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] text-ink-faint">Daily brief</p>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              {workspaceName} · {briefHeading(dashboard)}
            </h2>
            <p className="mt-1 text-[12px] text-ink-muted">
              Assembled from overdue Plans, partnership touchpoints, and contacts going cold.
            </p>
          </div>
          {workspaceId !== undefined && (
            <AgentTasks targetType="workspace" targetId={workspaceId} targetLabel={workspaceName} />
          )}
        </div>
        <ul className="mt-4 space-y-1.5">
          {briefLines(dashboard).map((line) => (
            <li key={line} className="flex gap-2 text-[13px] leading-relaxed text-ink">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-accent" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mb-8 grid gap-8 lg:grid-cols-2">
        <AttentionList rows={attentionRows(dashboard)} />
        <ActivityFeed activities={dashboard.recentActivity} nameById={nameById} now={now} />
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <NotesList notes={dashboard.recentNotes} nameById={nameById} now={now} />
        <DecisionsList decisions={dashboard.recentDecisions} nameById={nameById} />
      </div>
    </div>
  )
}

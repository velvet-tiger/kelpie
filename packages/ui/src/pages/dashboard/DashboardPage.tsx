import type { Dashboard } from '@kelpie/schemas'

import { useTimezone } from '../../api/resources/account.ts'
import { useDashboard } from '../../api/resources/dashboard.ts'
import { useMembers } from '../../api/resources/members.ts'
import { useWorkspace } from '../../api/resources/workspace.ts'
import { AgentTasks } from '../../components/AgentTasks.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { attentionRows } from './attention.ts'
import { ActivityFeed, AttentionList, DecisionsList, NotesList } from './sections.tsx'

/**
 * The workspace home: what is open, what is late, and what happened lately.
 *
 * One request, not seven. `GET /v1/dashboard` answers the whole page, with the
 * name of every record it points at already resolved, so this file holds no
 * fetching beyond the two directories the shell needs anyway — the workspace,
 * for its name, and the team, to turn an author id into a person.
 */

export function DashboardPage(): React.JSX.Element {
  const { dashboard, isLoading, error } = useDashboard()
  const { workspace } = useWorkspace()
  const { nameById } = useMembers()
  const timezone = useTimezone()
  const workspaceName = workspace?.name ?? 'This workspace'

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Dashboard"
        description="What needs attention across this workspace."
        actions={
          workspace?.id !== undefined ? (
            <AgentTasks
              targetType="workspace"
              targetId={workspace.id}
              targetLabel={workspaceName}
            />
          ) : undefined
        }
      />

      {error !== null && <ErrorPanel error={error} />}
      {isLoading && <LoadingPanel label="Loading the workspace…" />}

      {dashboard !== undefined && (
        <DashboardBody dashboard={dashboard} nameById={nameById} timezone={timezone} />
      )}
    </div>
  )
}

function DashboardBody({
  dashboard,
  nameById,
  timezone,
}: {
  readonly dashboard: Dashboard
  readonly nameById: ReadonlyMap<string, string>
  readonly timezone: string
}): React.JSX.Element {
  // `generatedAt` rather than a fresh `new Date()`: every relative time on the
  // page is then measured from the same instant the counts were, so a tab left
  // open does not creep towards "2 hours ago" on rows that never moved.
  const now = dashboard.generatedAt

  return (
    <div>
      <div className="mb-8 grid gap-8 lg:grid-cols-2">
        <AttentionList rows={attentionRows(dashboard)} />
        <ActivityFeed
          activities={dashboard.recentActivity}
          nameById={nameById}
          now={now}
          timezone={timezone}
        />
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <NotesList notes={dashboard.recentNotes} nameById={nameById} now={now} timezone={timezone} />
        <DecisionsList decisions={dashboard.recentDecisions} nameById={nameById} timezone={timezone} />
      </div>
    </div>
  )
}

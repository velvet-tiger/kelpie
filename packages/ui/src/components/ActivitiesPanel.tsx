import type { Activity, ActivityKind, RecordTargetType } from '@kelpie/schemas'

import { useActivities } from '../api/resources/activities.ts'
import { useMembers } from '../api/resources/members.ts'
import { formatRelativeTime, monthLabel } from '../lib/dates.ts'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * What happened to one record, newest first, grouped by month.
 *
 * Read-only, because the API is. Every row here was written by the service that
 * made the change.
 *
 * The roll-up is the server's: a person's timeline already carries the deals and
 * partnerships they are on, so nothing here fetches related records to merge in.
 *
 * A rolled-up row says which kind of record it came from and stops there. The
 * mockup also names it and links to it, which needs the Deals, Opportunities and
 * Partnerships endpoints. Naming a record this page cannot fetch would mean
 * printing an id or inventing a label, and both are worse than the type alone.
 */

export interface ActivitiesPanelProps {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

/** Two letters per kind, as the mockup's timeline gutter shows them. */
const KIND_GLYPHS: Readonly<Record<ActivityKind, string>> = {
  created: 'Cr',
  updated: 'Up',
  stage_changed: 'St',
  note_added: 'Nt',
  email: 'Em',
  call: 'Ca',
  meeting: 'Mt',
  linked: 'Ln',
}

const TARGET_TYPE_LABELS: Readonly<Record<RecordTargetType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  candidate: 'Candidate',
}

interface MonthGroup {
  readonly label: string
  readonly items: readonly Activity[]
}

/** Consecutive runs, not a map: the list is already ordered, so a month never recurs. */
function groupByMonth(activities: readonly Activity[], now: Date): readonly MonthGroup[] {
  const groups: { label: string; items: Activity[] }[] = []

  for (const activity of activities) {
    const label = monthLabel(activity.createdAt, now)
    const last = groups.at(-1)

    if (last?.label === label) {
      last.items.push(activity)
    } else {
      groups.push({ label, items: [activity] })
    }
  }

  return groups
}

export function ActivitiesPanel({
  targetType,
  targetId,
}: ActivitiesPanelProps): React.JSX.Element {
  const activities = useActivities({ targetType, targetId })
  const members = useMembers()
  const groups = groupByMonth(activities.records, new Date())

  return (
    <section>
      <SectionHeader title="Activity" />

      {activities.error !== null && <ErrorPanel error={activities.error} />}
      {activities.isLoading && <p className="text-[13px] text-ink-faint">Loading activity…</p>}

      {!activities.isLoading && activities.records.length === 0 && activities.error === null && (
        <p className="text-[13px] text-ink-faint">No activity yet.</p>
      )}

      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            <h3 className="mb-2 text-[12px] font-semibold text-ink">{group.label}</h3>
            <ol className="overflow-hidden rounded-md border border-border">
              {group.items.map((activity, index) => (
                <ActivityEvent
                  key={activity.id}
                  activity={activity}
                  actorName={actorNameFor(activity, members.nameById)}
                  contextType={targetType}
                  contextId={targetId}
                  isLast={index === group.items.length - 1}
                />
              ))}
            </ol>
          </div>
        ))}
      </div>

      {activities.hasMore && (
        <button
          type="button"
          onClick={activities.loadMore}
          disabled={activities.isLoadingMore}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
        >
          {activities.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  )
}

/**
 * The single most recent event, for a record's Overview tab.
 *
 * Its own request rather than a slice of the panel's: the panel lives on a
 * different tab, so on Overview there is no list to take the first row of.
 */
export function LatestActivity({
  targetType,
  targetId,
}: ActivitiesPanelProps): React.JSX.Element {
  const activities = useActivities({ targetType, targetId })
  const members = useMembers()
  const latest = activities.records[0]

  return (
    <section>
      <SectionHeader title="Latest activity" />

      {activities.error !== null && <ErrorPanel error={activities.error} />}
      {activities.isLoading && <p className="text-[13px] text-ink-faint">Loading activity…</p>}

      {!activities.isLoading && latest === undefined && activities.error === null && (
        <p className="text-[13px] text-ink-faint">No activity yet.</p>
      )}

      {latest !== undefined && (
        <ol className="overflow-hidden rounded-md border border-border">
          <ActivityEvent
            activity={latest}
            actorName={actorNameFor(latest, members.nameById)}
            contextType={targetType}
            contextId={targetId}
            isLast
          />
        </ol>
      )}
    </section>
  )
}

/**
 * Exactly one of the two actor columns is set. `actorLabel` carries the display
 * name when nothing on the team did this: "Form", "Gmail", "API key".
 */
function actorNameFor(activity: Activity, nameById: ReadonlyMap<string, string>): string {
  if (activity.actorMemberId === null) {
    return activity.actorLabel ?? 'System'
  }

  return nameById.get(activity.actorMemberId) ?? 'Unknown'
}

function ActivityEvent({
  activity,
  actorName,
  contextType,
  contextId,
  isLast,
}: {
  readonly activity: Activity
  readonly actorName: string
  readonly contextType: RecordTargetType
  readonly contextId: string
  readonly isLast: boolean
}): React.JSX.Element {
  const isRolledUp = activity.targetType !== contextType || activity.targetId !== contextId

  return (
    <li className="flex gap-2 border-b border-border px-4 py-3 last:border-0">
      <div className="relative flex w-5 shrink-0 justify-center">
        {!isLast && (
          <span
            aria-hidden
            className="absolute top-5 bottom-[-12px] left-1/2 w-px -translate-x-1/2 bg-border"
          />
        )}
        <div
          className="relative z-10 flex h-5 w-5 items-center justify-center rounded border border-border bg-surface text-[9px] font-semibold tracking-wide text-ink-muted uppercase"
          title={activity.kind}
        >
          {KIND_GLYPHS[activity.kind]}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-[12px] leading-snug text-ink">
            <span className="font-semibold">{actorName}</span>{' '}
            <span className="text-ink-muted">{activity.action}</span>
          </p>
          <time
            dateTime={activity.createdAt.toISOString()}
            className="shrink-0 text-[11px] text-ink-faint"
          >
            {formatRelativeTime(activity.createdAt)}
          </time>
        </div>
        {isRolledUp && (
          <p className="text-[11px] leading-snug text-ink-faint">
            on <span className="text-ink-muted">{TARGET_TYPE_LABELS[activity.targetType]}</span>
          </p>
        )}
        {activity.detail !== null && (
          <p className="text-[11px] leading-snug text-ink-faint">{activity.detail}</p>
        )}
      </div>
    </li>
  )
}

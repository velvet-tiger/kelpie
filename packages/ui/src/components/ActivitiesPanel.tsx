import type { Activity, ActivityKind, RecordTargetType } from '@kelpie/schemas'

import { useTimezone } from '../api/resources/account.ts'
import { useActivities } from '../api/resources/activities.ts'
import { useMembers } from '../api/resources/members.ts'
import { formatRelativeTime, monthLabel } from '../lib/dates.ts'
import { Paginator } from './Paginator.tsx'
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
  unlinked: 'Un',
}

const TARGET_TYPE_LABELS: Readonly<Record<RecordTargetType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  enquiry: 'Enquiry',
  candidate: 'Candidate',
}

interface MonthGroup {
  readonly label: string
  readonly items: readonly Activity[]
}

/** How many events the Overview tab's latest-activity block shows. */
const LATEST_ACTIVITY_COUNT = 5

/** Consecutive runs, not a map: the list is already ordered, so a month never recurs. */
function groupByMonth(
  activities: readonly Activity[],
  timezone: string,
  now: Date,
): readonly MonthGroup[] {
  const groups: { label: string; items: Activity[] }[] = []

  for (const activity of activities) {
    const label = monthLabel(activity.createdAt, timezone, now)
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
  const timezone = useTimezone()
  const groups = groupByMonth(activities.records, timezone, new Date())

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
                  timezone={timezone}
                />
              ))}
            </ol>
          </div>
        ))}
      </div>

      <Paginator list={activities} />
    </section>
  )
}

/**
 * The five most recent events, for a record's Overview tab.
 *
 * Its own request rather than a slice of the panel's: the panel lives on a
 * different tab, so on Overview there is no list to take the first rows of.
 */
export function LatestActivity({
  targetType,
  targetId,
}: ActivitiesPanelProps): React.JSX.Element {
  const activities = useActivities({ targetType, targetId }, { limit: LATEST_ACTIVITY_COUNT })
  const members = useMembers()
  const timezone = useTimezone()
  const latest = activities.records

  return (
    <section>
      <SectionHeader title="Latest activity" />

      {activities.error !== null && <ErrorPanel error={activities.error} />}
      {activities.isLoading && <p className="text-[13px] text-ink-faint">Loading activity…</p>}

      {!activities.isLoading && latest.length === 0 && activities.error === null && (
        <p className="text-[13px] text-ink-faint">No activity yet.</p>
      )}

      {latest.length > 0 && (
        <ol className="overflow-hidden rounded-md border border-border">
          {latest.map((activity, index) => (
            <ActivityEvent
              key={activity.id}
              activity={activity}
              actorName={actorNameFor(activity, members.nameById)}
              contextType={targetType}
              contextId={targetId}
              isLast={index === latest.length - 1}
              timezone={timezone}
            />
          ))}
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
  timezone,
}: {
  readonly activity: Activity
  readonly actorName: string
  readonly contextType: RecordTargetType
  readonly contextId: string
  readonly isLast: boolean
  readonly timezone: string
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
            {formatRelativeTime(activity.createdAt, timezone)}
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

import type {
  ActivityKind,
  DashboardActivity,
  DashboardDecision,
  DashboardNote,
  TargetRef,
} from '@kelpie/schemas'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { Chip } from '../../components/Chip.tsx'
import { SectionHeader } from '../../components/SectionHeader.tsx'
import { formatDate, formatRelativeTime } from '../../lib/dates.ts'
import { targetHref, targetTypeLabel } from './attention.ts'
import type { AttentionRow } from './attention.ts'

/**
 * The four lists the workspace home is made of.
 *
 * Every row here points at a record other than the one being looked at, which is
 * what makes the dashboard different from a record's own panels: the response
 * carries `targetName` already resolved, so nothing below fetches anything.
 */

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

/** A record's name, as a link when it has a page and as text when it does not. */
function TargetLink({
  target,
  className = 'text-ink-muted hover:text-accent hover:underline',
}: {
  readonly target: TargetRef
  readonly className?: string
}): React.JSX.Element {
  const href = targetHref(target.targetType, target.targetId)
  const label = target.targetName ?? targetTypeLabel(target.targetType)

  if (href === undefined) {
    return <span className={className}>{label}</span>
  }

  return (
    <Link to={href} className={className}>
      {label}
    </Link>
  )
}

function EmptyOr({
  isEmpty,
  empty,
  children,
}: {
  readonly isEmpty: boolean
  readonly empty: string
  readonly children: ReactNode
}): React.JSX.Element {
  return isEmpty ? <p className="text-[13px] text-ink-faint">{empty}</p> : <>{children}</>
}

export function AttentionList({ rows }: { readonly rows: readonly AttentionRow[] }): React.JSX.Element {
  return (
    <section>
      <SectionHeader title="Needs attention" description="The signals behind the brief." />
      <EmptyOr isEmpty={rows.length === 0} empty="Nothing urgent right now.">
        <ul className="divide-y divide-border border-y border-border">
          {rows.map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={row.tone}>{row.label}</Chip>
                <span className="text-[11px] text-ink-faint">{row.meta}</span>
              </div>
              {row.href === undefined ? (
                <p className="mt-1.5 text-[13px] font-medium text-ink">{row.title}</p>
              ) : (
                <Link
                  to={row.href}
                  className="mt-1.5 block text-[13px] font-medium text-ink hover:text-accent"
                >
                  {row.title}
                </Link>
              )}
              {row.detail !== '' && (
                <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-muted">{row.detail}</p>
              )}
            </li>
          ))}
        </ul>
      </EmptyOr>
    </section>
  )
}

export function ActivityFeed({
  activities,
  nameById,
  now,
  timezone,
}: {
  readonly activities: readonly DashboardActivity[]
  readonly nameById: ReadonlyMap<string, string>
  readonly now: Date
  readonly timezone: string
}): React.JSX.Element {
  return (
    <section>
      <SectionHeader
        title="Recent activity"
        description="The latest events across people, companies, and pipelines."
      />
      <EmptyOr isEmpty={activities.length === 0} empty="No activity yet.">
        <ol className="divide-y divide-border border-y border-border">
          {activities.map((activity, index) => (
            <li key={activity.id} className="flex gap-2 py-3">
              <div className="relative flex w-5 shrink-0 justify-center">
                {index < activities.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute top-5 bottom-[-12px] left-1/2 w-px -translate-x-1/2 bg-border"
                  />
                )}
                <div
                  className="relative z-10 flex h-5 w-5 items-center justify-center rounded border border-border bg-surface text-[9px] font-medium tracking-wide text-ink-muted uppercase"
                  title={activity.kind}
                >
                  {KIND_GLYPHS[activity.kind]}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 text-[12px] leading-snug text-ink">
                    <span className="font-semibold">{actorNameFor(activity, nameById)}</span>{' '}
                    <span className="text-ink-muted">{activity.action}</span>
                  </p>
                  <time
                    dateTime={activity.createdAt.toISOString()}
                    className="shrink-0 text-[11px] text-ink-faint"
                  >
                    {formatRelativeTime(activity.createdAt, timezone, now)}
                  </time>
                </div>
                <p className="text-[11px] leading-snug text-ink-faint">
                  on <span className="text-ink-muted">{targetTypeLabel(activity.targetType)}</span>
                  {' · '}
                  <TargetLink target={activity} />
                </p>
                {activity.detail !== null && (
                  <p className="text-[11px] leading-snug text-ink-faint">{activity.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </EmptyOr>
    </section>
  )
}

/**
 * Exactly one of the two actor columns is set. `actorLabel` carries the display
 * name when nothing on the team did this: "Form", "Gmail", "API key".
 */
function actorNameFor(
  activity: DashboardActivity,
  nameById: ReadonlyMap<string, string>,
): string {
  if (activity.actorMemberId === null) {
    return activity.actorLabel ?? 'System'
  }

  return nameById.get(activity.actorMemberId) ?? 'Unknown'
}

export function NotesList({
  notes,
  nameById,
  now,
  timezone,
}: {
  readonly notes: readonly DashboardNote[]
  readonly nameById: ReadonlyMap<string, string>
  readonly now: Date
  readonly timezone: string
}): React.JSX.Element {
  return (
    <section>
      <SectionHeader title="Recent notes" description="Pinned notes surface first." />
      <EmptyOr isEmpty={notes.length === 0} empty="No notes yet.">
        <ul className="divide-y divide-border border-y border-border">
          {notes.map((note) => (
            <li key={note.id} className="py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-3 text-[13px] leading-relaxed text-ink">{note.body}</p>
                {note.pinned && (
                  <span className="shrink-0 text-[10px] font-medium tracking-wide text-accent uppercase">
                    Pinned
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                <TargetLink target={note} />
                <span>·</span>
                <span>{targetTypeLabel(note.targetType)}</span>
                <span>·</span>
                <span>{note.authorId === null ? 'System' : (nameById.get(note.authorId) ?? 'Unknown')}</span>
                <span>·</span>
                <span>{formatRelativeTime(note.createdAt, timezone, now)}</span>
              </div>
            </li>
          ))}
        </ul>
      </EmptyOr>
    </section>
  )
}

export function DecisionsList({
  decisions,
  nameById,
  timezone,
}: {
  readonly decisions: readonly DashboardDecision[]
  readonly nameById: ReadonlyMap<string, string>
  readonly timezone: string
}): React.JSX.Element {
  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-ink">Recent decisions</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Commitments agents should not contradict.
          </p>
        </div>
        <Link to="/decisions" className="shrink-0 text-[12px] font-medium text-accent hover:underline">
          View all
        </Link>
      </div>
      <EmptyOr isEmpty={decisions.length === 0} empty="No decisions yet.">
        <ul className="divide-y divide-border border-y border-border">
          {decisions.map((decision) => (
            <li key={decision.id} className="py-3">
              <p className="text-[13px] font-medium text-ink">{decision.body}</p>
              {decision.rationale !== null && (
                <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-muted">
                  {decision.rationale}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                <TargetLink target={decision} />
                <span>·</span>
                <span>{formatDate(decision.decidedAt, timezone)}</span>
                <span>·</span>
                <span>
                  {decision.ownerId === null ? '—' : (nameById.get(decision.ownerId) ?? 'Unknown')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </EmptyOr>
    </section>
  )
}

import {
  PIPELINE_KIND_LABELS,
  PIPELINE_KINDS,
  PLAN_ITEM_STATUS_LABELS,
  PLAN_ITEM_STATUSES,
} from '@kelpie/schemas'
import type { PipelineKind, PlanItem, PlanItemStatus } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useDeals } from '../api/resources/deals.ts'
import { useMembers } from '../api/resources/members.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePartnerships } from '../api/resources/partnerships.ts'
import {
  MAX_PAGE_SIZE,
  useCreatePlanItem,
  usePlanItems,
} from '../api/resources/planItems.ts'
import { useRaises } from '../api/resources/raises.ts'
import { Chip } from '../components/Chip.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PlanTargetLink } from '../components/PlanAttention.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDay } from '../lib/dates.ts'
import { monthBounds, planStatusTone, todayIso } from '../lib/plan.ts'

/**
 * Every dated step in the workspace, as a list or as a month.
 *
 * The two views ask the API different questions. The list wants everything
 * upcoming and pages through it; the calendar wants one month, which is what
 * `?from=` and `?to=` are for, so moving between months is a request rather than
 * a filter over rows the page happens to hold.
 *
 * Adding a plan item lives here as well as on each record's Plan panel: the page
 * is the workspace-wide view of the same resource, so create belongs here too.
 */

type ViewMode = 'list' | 'calendar'
type TypeFilter = PipelineKind | 'all'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** How many of a day's items a calendar cell shows before summarising the rest. */
const CELL_ITEM_LIMIT = 3

const MONTH_AND_YEAR = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

const inputClass =
  'h-9 w-full rounded-md border border-border bg-surface-raised px-2.5 text-[13px] outline-none focus:border-accent'

interface PipelineTarget {
  readonly id: string
  readonly name: string
}

export function PlanningPage(): React.JSX.Element {
  const [view, setView] = useState<ViewMode>('list')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [adding, setAdding] = useState(false)
  const [month, setMonth] = useState(() => {
    const now = new Date()

    return { year: now.getFullYear(), month: now.getMonth() }
  })

  const targets = usePipelineTargets()
  const createItem = useCreatePlanItem()

  const typeQuery = typeFilter === 'all' ? {} : { targetType: typeFilter }
  // A month is a bounded question, so the calendar asks for it at the largest
  // page size and draws the answer whole. The list pages the ordinary way.
  const items = usePlanItems(
    view === 'calendar'
      ? { ...typeQuery, ...monthBounds(month.year, month.month), limit: MAX_PAGE_SIZE }
      : typeQuery,
  )

  function shiftMonth(delta: number): void {
    setMonth((current) => {
      const moved = new Date(current.year, current.month + delta, 1)

      return { year: moved.getFullYear(), month: moved.getMonth() }
    })
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Planning"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add plan item"
        actions={
          <>
            <label className="sr-only" htmlFor="plan-type-filter">
              Record type
            </label>
            <select
              id="plan-type-filter"
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value as TypeFilter)
              }}
              className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[12px] outline-none focus:border-accent"
            >
              <option value="all">All types</option>
              {PIPELINE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PIPELINE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <SegmentedControl
              ariaLabel="List or calendar"
              value={view}
              onChange={setView}
              options={[
                { id: 'list', label: 'List' },
                { id: 'calendar', label: 'Calendar' },
              ]}
            />
          </>
        }
      />

      {adding && (
        <AddPlanItemForm
          initialTargetType={typeFilter === 'all' ? 'deal' : typeFilter}
          targetsByKind={targets.byKind}
          isPending={createItem.isPending}
          error={createItem.error}
          onCancel={() => {
            setAdding(false)
          }}
          onSubmit={(fields) => {
            createItem
              .runAsync({
                targetType: fields.targetType,
                targetId: fields.targetId,
                date: fields.date,
                title: fields.title,
                ownerId: fields.ownerId.length === 0 ? null : fields.ownerId,
                status: fields.status,
              })
              .then(() => {
                setAdding(false)
              })
              .catch(() => undefined)
          }}
        />
      )}

      {view === 'calendar' && (
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              shiftMonth(-1)
            }}
            aria-label="Previous month"
            className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            ←
          </button>
          <span className="min-w-[140px] text-center text-[13px] font-semibold text-ink">
            {MONTH_AND_YEAR.format(new Date(month.year, month.month, 1))}
          </span>
          <button
            type="button"
            onClick={() => {
              shiftMonth(1)
            }}
            aria-label="Next month"
            className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            →
          </button>
        </div>
      )}

      {items.error !== null ? (
        <ErrorPanel error={items.error} />
      ) : items.isLoading ? (
        <LoadingPanel label="Loading plan…" />
      ) : view === 'list' ? (
        <PlanList items={items.records} targetNames={targets.nameById} />
      ) : (
        <PlanCalendar year={month.year} month={month.month} items={items.records} />
      )}

      {items.hasMore && (
        <button
          type="button"
          onClick={items.loadMore}
          disabled={items.isLoadingMore}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
        >
          {items.isLoadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

/**
 * Pipeline records the add form can attach to, and the name map the list uses
 * for PlanTargetLink. One page per kind, same ceiling as the rest of Planning.
 */
function usePipelineTargets(): {
  readonly byKind: Readonly<Record<PipelineKind, readonly PipelineTarget[]>>
  readonly nameById: ReadonlyMap<string, string>
} {
  const deals = useDeals({ limit: MAX_PAGE_SIZE })
  const opportunities = useOpportunities({ limit: MAX_PAGE_SIZE })
  const raises = useRaises({ limit: MAX_PAGE_SIZE })
  const partnerships = usePartnerships({ limit: MAX_PAGE_SIZE })

  const byKind: Readonly<Record<PipelineKind, readonly PipelineTarget[]>> = {
    deal: deals.records.map((record) => ({ id: record.id, name: record.name })),
    opportunity: opportunities.records.map((record) => ({ id: record.id, name: record.name })),
    raise: raises.records.map((record) => ({ id: record.id, name: record.name })),
    partnership: partnerships.records.map((record) => ({ id: record.id, name: record.name })),
  }

  return {
    byKind,
    nameById: new Map(
      Object.values(byKind)
        .flat()
        .map((record) => [record.id, record.name]),
    ),
  }
}

interface AddPlanItemFields {
  readonly targetType: PipelineKind
  readonly targetId: string
  readonly date: string
  readonly title: string
  readonly ownerId: string
  readonly status: PlanItemStatus
}

function AddPlanItemForm({
  initialTargetType,
  targetsByKind,
  isPending,
  error,
  onSubmit,
  onCancel,
}: {
  readonly initialTargetType: PipelineKind
  readonly targetsByKind: Readonly<Record<PipelineKind, readonly PipelineTarget[]>>
  readonly isPending: boolean
  readonly error: Error | null
  readonly onSubmit: (fields: AddPlanItemFields) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const members = useMembers()
  const [draft, setDraft] = useState<AddPlanItemFields>({
    targetType: initialTargetType,
    targetId: '',
    date: todayIso(),
    title: '',
    ownerId: '',
    status: 'todo',
  })

  const targets = targetsByKind[draft.targetType]

  function submit(event: FormEvent): void {
    event.preventDefault()

    const title = draft.title.trim()

    if (title.length === 0 || draft.date.length === 0 || draft.targetId.length === 0) {
      return
    }

    onSubmit({ ...draft, title })
  }

  return (
    <form onSubmit={submit} className="mb-4 space-y-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <select
          value={draft.targetType}
          onChange={(event) => {
            const targetType = event.target.value as PipelineKind

            setDraft((current) => ({ ...current, targetType, targetId: '' }))
          }}
          aria-label="Record type"
          className={inputClass}
        >
          {PIPELINE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {PIPELINE_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <select
          value={draft.targetId}
          onChange={(event) => {
            setDraft((current) => ({ ...current, targetId: event.target.value }))
          }}
          required
          aria-label="Record"
          className={inputClass}
        >
          <option value="">{targets.length === 0 ? 'No records' : 'Select…'}</option>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={draft.date}
          onChange={(event) => {
            setDraft((current) => ({ ...current, date: event.target.value }))
          }}
          required
          aria-label="Date"
          className={inputClass}
        />
        <input
          value={draft.title}
          onChange={(event) => {
            setDraft((current) => ({ ...current, title: event.target.value }))
          }}
          placeholder="What happens…"
          required
          autoFocus
          aria-label="What happens"
          className={inputClass}
        />

        <select
          value={draft.ownerId}
          onChange={(event) => {
            setDraft((current) => ({ ...current, ownerId: event.target.value }))
          }}
          aria-label="Owner"
          className={inputClass}
        >
          <option value="">Unassigned</option>
          {members.members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <select
          value={draft.status}
          onChange={(event) => {
            setDraft((current) => ({
              ...current,
              status: event.target.value as PlanItemStatus,
            }))
          }}
          aria-label="Status"
          className={inputClass}
        >
          {PLAN_ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PLAN_ITEM_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {error !== null && <ErrorPanel error={error} />}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || targets.length === 0}
          className="h-9 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  )
}

function PlanList({
  items,
  targetNames,
}: {
  readonly items: readonly PlanItem[]
  readonly targetNames: ReadonlyMap<string, string>
}): React.JSX.Element {
  const members = useMembers()

  if (items.length === 0) {
    return <p className="text-[13px] text-ink-faint">No plan items match this filter.</p>
  }

  return (
    <ul className="overflow-hidden rounded-md border border-border">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0"
        >
          <time
            dateTime={item.date}
            className="w-[120px] shrink-0 text-[12px] font-medium text-ink tabular-nums"
          >
            {formatDay(item.date)}
          </time>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink">{item.title}</div>
            <PlanTargetLink item={item} targetNames={targetNames} />
          </div>
          {item.ownerId !== null && (
            <span className="text-[12px] text-ink-muted">
              {members.nameById.get(item.ownerId) ?? 'Unknown'}
            </span>
          )}
          <Chip tone={planStatusTone(item.status)}>{PLAN_ITEM_STATUS_LABELS[item.status]}</Chip>
        </li>
      ))}
    </ul>
  )
}

interface CalendarCell {
  readonly key: string
  /** null in the padding before the first and after the last day of the month. */
  readonly date: string | null
  readonly day: number | null
}

/** Monday-first cells, padded to whole weeks. `Date.getDay()` counts from Sunday. */
function calendarCells(year: number, month: number): readonly CalendarCell[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const dayCount = new Date(year, month + 1, 0).getDate()
  const cells: CalendarCell[] = []

  for (let index = 0; index < firstWeekday; index++) {
    cells.push({ key: `lead-${String(index)}`, date: null, day: null })
  }

  for (let day = 1; day <= dayCount; day++) {
    const date = `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

    cells.push({ key: date, date, day })
  }

  while (cells.length % 7 !== 0) {
    cells.push({ key: `trail-${String(cells.length)}`, date: null, day: null })
  }

  return cells
}

function PlanCalendar({
  year,
  month,
  items,
}: {
  readonly year: number
  readonly month: number
  readonly items: readonly PlanItem[]
}): React.JSX.Element {
  const today = todayIso()
  const byDay = new Map<string, PlanItem[]>()

  for (const item of items) {
    const existing = byDay.get(item.date)

    if (existing === undefined) {
      byDay.set(item.date, [item])
    } else {
      existing.push(item)
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-7 border-b border-border bg-surface">
        {WEEKDAYS.map((weekday) => (
          <div
            key={weekday}
            className="px-2 py-2 text-center text-[10px] font-semibold tracking-wide text-ink-faint uppercase"
          >
            {weekday}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {calendarCells(year, month).map((cell) => {
          const dayItems = cell.date === null ? [] : (byDay.get(cell.date) ?? [])

          return (
            <div
              key={cell.key}
              className={[
                'min-h-[96px] border-r border-b border-border p-1.5 last:border-r-0',
                cell.date === null ? 'bg-surface' : 'bg-surface-raised',
              ].join(' ')}
            >
              {cell.day !== null && (
                <div
                  className={[
                    'mb-1 text-[11px] font-medium',
                    cell.date === today ? 'text-accent' : 'text-ink-muted',
                  ].join(' ')}
                >
                  {cell.day}
                </div>
              )}
              <ul className="space-y-1">
                {dayItems.slice(0, CELL_ITEM_LIMIT).map((item) => (
                  <li key={item.id}>
                    <span
                      title={item.title}
                      className="block truncate rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-hover"
                    >
                      {item.title}
                    </span>
                  </li>
                ))}
                {dayItems.length > CELL_ITEM_LIMIT && (
                  <li className="px-1 text-[10px] text-ink-faint">
                    +{dayItems.length - CELL_ITEM_LIMIT} more
                  </li>
                )}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

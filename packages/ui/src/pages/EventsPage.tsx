import {
  EVENT_FORMAT_LABELS,
  EVENT_STATUS_LABELS,
} from '@kelpie/schemas'
import type { Event as CrmEvent, EventFormat, EventStatus } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCreateEvent, useEvents } from '../api/resources/events.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDateTime } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { serverSortOnly } from '../lib/sort.ts'

/**
 * Events list and month calendar. Upcoming is the default. Not a kanban.
 */

type Scope = 'upcoming' | 'past' | 'all'
type BoardView = 'list' | 'calendar'

const DEFAULT_VISIBLE_KEYS: readonly string[] = ['name', 'starts', 'format', 'status', 'location']
const SERVER_SORT_KEYS: readonly string[] = ['name', 'starts_at', 'created_at', 'updated_at']
const MONTH_AND_YEAR = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

const STATUS_TONES: Readonly<Record<EventStatus, ChipTone>> = {
  draft: 'neutral',
  scheduled: 'accent',
  cancelled: 'danger',
}

function dayKey(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

export function EventsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<Scope>('upcoming')
  const [board, setBoard] = useState<BoardView>('list')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const navigate = useNavigate()
  const timezone = useTimezone()
  const now = new Date()
  const [month, setMonth] = useState({ year: now.getFullYear(), month: now.getMonth() })
  const createEvent = useCreateEvent()

  const fromTo =
    board === 'calendar'
      ? monthBounds(month.year, month.month)
      : scope === 'upcoming'
        ? { from: now.toISOString(), to: undefined }
        : scope === 'past'
          ? { from: undefined, to: now.toISOString() }
          : { from: undefined, to: undefined }

  const events = useEvents({
    term: term.trim().length > 0 ? term.trim() : undefined,
    from: fromTo.from,
    to: fromTo.to,
    sort: serverSortOnly(
      sort ?? (scope === 'past' ? '-starts_at' : 'starts_at'),
      SERVER_SORT_KEYS,
    ),
    limit: board === 'calendar' ? 200 : undefined,
  })

  async function addEvent(event: FormEvent): Promise<void> {
    event.preventDefault()

    const trimmed = name.trim()

    if (trimmed.length === 0) {
      return
    }

    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000)
    const created = await createEvent.runAsync({
      name: trimmed,
      startsAt,
      endsAt,
      format: 'virtual',
    })

    setAdding(false)
    setName('')
    await navigate(`/events/${created.id}`)
  }

  const columns: readonly Column<CrmEvent>[] = [
    {
      key: 'name',
      header: 'Event',
      sortKey: 'name',
      render: (record) => <span className="font-medium text-ink">{record.name}</span>,
    },
    {
      key: 'starts',
      header: 'Starts',
      sortKey: 'starts_at',
      render: (record) => (
        <span className="tabular-nums text-ink-muted">
          {formatDateTime(record.startsAt, timezone)}
        </span>
      ),
    },
    {
      key: 'format',
      header: 'Format',
      getSortValue: (record) => record.format,
      render: (record) => EVENT_FORMAT_LABELS[record.format as EventFormat] ?? record.format,
    },
    {
      key: 'status',
      header: 'Status',
      getSortValue: (record) => record.status,
      render: (record) => (
        <Chip tone={STATUS_TONES[record.status] ?? 'neutral'}>
          {EVENT_STATUS_LABELS[record.status] ?? record.status}
        </Chip>
      ),
    },
    {
      key: 'location',
      header: 'Location',
      getSortValue: (record) => record.location,
      render: (record) => (
        <span className="text-ink-muted">{record.location.length > 0 ? record.location : '—'}</span>
      ),
    },
  ]

  const supportedKeys = columns.map((column) => column.key)
  const listView = useListView('events', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Events"
        onAdd={() => {
          setAdding(true)
        }}
        addLabel="Add event"
        actions={
          <>
            <SegmentedControl
              ariaLabel="Upcoming or past"
              value={scope}
              onChange={setScope}
              options={[
                { id: 'upcoming', label: 'Upcoming' },
                { id: 'past', label: 'Past' },
                { id: 'all', label: 'All' },
              ]}
            />
            <SegmentedControl
              ariaLabel="List or calendar"
              value={board}
              onChange={setBoard}
              options={[
                { id: 'list', label: 'List' },
                { id: 'calendar', label: 'Calendar' },
              ]}
            />
            <ColumnPicker
              options={pickerOptions}
              visibleKeys={listView.visibleKeys}
              onChange={listView.setVisibleKeys}
            />
          </>
        }
      />

      <FilterBar value={term} onChange={setTerm} placeholder="Search events…" />

      {adding && (
        <form
          onSubmit={(event) => {
            void addEvent(event)
          }}
          className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
        >
          <label className="min-w-[220px] flex-1 text-[12px] font-medium text-ink-muted">
            Name
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              className="mt-1 w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              autoFocus
            />
          </label>
          <button
            type="submit"
            disabled={createEvent.isPending || name.trim().length === 0}
            className="rounded-md bg-accent px-3 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false)
              setName('')
            }}
            className="text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          {createEvent.error !== null && <ErrorPanel error={createEvent.error} />}
        </form>
      )}

      {events.error !== null ? (
        <ErrorPanel error={events.error} />
      ) : events.isLoading ? (
        <LoadingPanel label="Loading events…" />
      ) : board === 'calendar' ? (
        <EventCalendar
          year={month.year}
          month={month.month}
          timezone={timezone}
          events={events.records}
          onShift={(delta) => {
            setMonth((current) => {
              const next = new Date(current.year, current.month + delta, 1)

              return { year: next.getFullYear(), month: next.getMonth() }
            })
          }}
        />
      ) : (
        <>
          <Paginator list={events} placement="top" />
          <DataTable
            columns={columns}
            rows={events.records}
            getRowId={(record) => record.id}
            onRowClick={(record) => {
              void navigate(`/events/${record.id}`)
            }}
            emptyMessage={term.trim().length > 0 ? 'No events match this filter' : 'No events yet'}
            sort={sort}
            onSortChange={setSort}
            visibleColumnKeys={listView.visibleKeys}
          />
          <Paginator list={events} />
        </>
      )}
    </div>
  )
}

function monthBounds(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month, 1))
  const to = new Date(Date.UTC(year, month + 1, 1))

  return { from: from.toISOString(), to: to.toISOString() }
}

function calendarCells(year: number, month: number): readonly { key: string; date: string | null; day: number | null }[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const dayCount = new Date(year, month + 1, 0).getDate()
  const cells: { key: string; date: string | null; day: number | null }[] = []

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

function EventCalendar({
  year,
  month,
  timezone,
  events,
  onShift,
}: {
  readonly year: number
  readonly month: number
  readonly timezone: string
  readonly events: readonly CrmEvent[]
  readonly onShift: (delta: number) => void
}): React.JSX.Element {
  const byDay = useMemo(() => {
    const grouped = new Map<string, CrmEvent[]>()

    for (const record of events) {
      const key = dayKey(record.startsAt, timezone)
      const held = grouped.get(key) ?? []

      held.push(record)
      grouped.set(key, held)
    }

    return grouped
  }, [events, timezone])

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onShift(-1)
          }}
          aria-label="Previous month"
          className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          ←
        </button>
        <span className="min-w-[140px] text-center text-[13px] font-semibold text-ink">
          {MONTH_AND_YEAR.format(new Date(year, month, 1))}
        </span>
        <button
          type="button"
          onClick={() => {
            onShift(1)
          }}
          aria-label="Next month"
          className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <div key={label} className="bg-surface px-2 py-1 text-[11px] font-medium text-ink-muted">
            {label}
          </div>
        ))}
        {calendarCells(year, month).map((cell) => (
          <div key={cell.key} className="min-h-[88px] bg-surface p-1.5">
            {cell.day !== null && (
              <div className="text-[11px] font-medium text-ink-muted">{cell.day}</div>
            )}
            {cell.date !== null &&
              (byDay.get(cell.date) ?? []).map((record) => (
                <Link
                  key={record.id}
                  to={`/events/${record.id}`}
                  className="mt-1 block truncate text-[11px] font-medium text-accent hover:underline"
                >
                  {record.name}
                </Link>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

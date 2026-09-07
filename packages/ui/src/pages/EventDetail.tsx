import {
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUSES,
  EVENT_ASSOCIATION_TARGET_TYPE_LABELS,
  EVENT_ASSOCIATION_TARGET_TYPES,
  EVENT_FORMAT_LABELS,
  EVENT_FORMATS,
  EVENT_STATUS_LABELS,
  EVENT_STATUSES,
} from '@kelpie/schemas'
import type {
  Attendance,
  AttendanceStatus,
  Event as CrmEvent,
  EventAssociation,
  EventAssociationTargetType,
  EventFormat,
  EventInput,
  EventStatus,
} from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCandidates } from '../api/resources/candidates.ts'
import { useCompanies } from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { useEnquiries } from '../api/resources/enquiries.ts'
import {
  useAttendances,
  useCreateAttendance,
  useDeleteAttendance,
  useUpdateAttendance,
} from '../api/resources/attendances.ts'
import { useDeleteEvent, useEvent, useUpdateEvent } from '../api/resources/events.ts'
import { useMembers } from '../api/resources/members.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePartnerships } from '../api/resources/partnerships.ts'
import { usePeople } from '../api/resources/people.ts'
import { useRecordPlanItems } from '../api/resources/planItems.ts'
import { useRaises } from '../api/resources/raises.ts'
import { useRoles } from '../api/resources/roles.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { CustomFieldsPanel } from '../components/CustomFieldsPanel.tsx'
import { useHasCustomFields } from '../components/useHasCustomFields.ts'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { ListsPanel } from '../components/ListsPanel.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
import { PlanAttention } from '../components/PlanAttention.tsx'
import { PlanPanel } from '../components/PlanPanel.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import type { RecordTabDescriptor } from '../components/RecordTabs.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import { SidebarField } from '../components/SidebarField.tsx'
import { SummaryBlock } from '../components/SummaryBlock.tsx'
import { formatDateTime } from '../lib/dates.ts'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toTags } from './fields.ts'

/**
 * One dated gathering. Not a pipeline: no stages, no convert, no kanban.
 *
 * People register as Attendances. Other records attach through Event-only
 * associations. Prep work lives on Plan items on this Event.
 */

const STATUS_TONES: Readonly<Record<EventStatus, ChipTone>> = {
  draft: 'neutral',
  scheduled: 'accent',
  cancelled: 'danger',
}

const ATTENDANCE_TONES: Readonly<Record<AttendanceStatus, ChipTone>> = {
  registered: 'accent',
  attended: 'success',
  no_show: 'warning',
  cancelled: 'danger',
}

const ASSOCIATION_ROUTES: Readonly<Partial<Record<EventAssociationTargetType, string>>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  opportunity: '/opportunities',
  partnership: '/partnerships',
  raise: '/fundraising',
  enquiry: '/enquiries',
  role: '/hiring',
}

export function EventDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useEvent(id)
  const deleteEvent = useDeleteEvent()
  const moduleTabs = inSlotOrder(useRecordTabs('event'))
  const hasCustomFields = useHasCustomFields('event')
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Event" backTo="/events" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading event…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
    ...(hasCustomFields ? [{ id: 'fields', label: 'Fields' }] : []),
    { id: 'plan', label: 'Plan' },
    { id: 'attendees', label: 'Attendees' },
    { id: 'activity', label: 'Activity' },
    { id: 'notes', label: 'Notes' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'lists', label: 'Lists' },
    ...moduleTabs.map((tab) => ({ id: tab.id, label: tab.label })),
  ]
  const active = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'overview'
  const moduleTab = moduleTabs.find((tab) => tab.id === active)

  return (
    <div className="animate-fade-in mx-auto max-w-6xl">
      <Link
        to="/events"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Events
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <EventHeading event={record} />

          <div className="flex justify-end gap-2">
            <AgentTasks targetType="event" targetId={record.id} targetLabel={record.name} />
            <DeleteRecord
              recordLabel="Event"
              recordName={record.name}
              isPending={deleteEvent.isPending}
              error={deleteEvent.error}
              onConfirm={() => {
                deleteEvent
                  .runAsync(record.id)
                  .then(() => navigate('/events'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Event sections"
          >
            {active === 'overview' && <EventOverview event={record} />}
            {active === 'fields' && <EventFields event={record} />}
            {active === 'plan' && <PlanPanel targetType="event" targetId={record.id} />}
            {active === 'attendees' && <EventAttendees event={record} />}
            {active === 'activity' && <ActivitiesPanel targetType="event" targetId={record.id} />}
            {active === 'notes' && <NotesPanel targetType="event" targetId={record.id} />}
            {active === 'decisions' && <DecisionsPanel targetType="event" targetId={record.id} />}
            {active === 'lists' && <ListsPanel targetType="event" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'event', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <EventSidebar event={record} />
          <EventAssociationsCard event={record} />
        </aside>
      </div>
    </div>
  )
}

function useEventPatch(event: CrmEvent): PatchResult<EventInput> {
  return usePatch(useUpdateEvent, event)
}

function EventHeading({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const { patch, error } = useEventPatch(event)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={event.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled event"
      />
      <div className="mt-1">
        <InlineEdit
          value={event.kind}
          onChange={(kind) => {
            patch({ kind })
          }}
          displayClassName="text-[13px] text-ink-muted not-italic"
          emptyLabel="Add kind…"
        />
      </div>
    </div>
  )
}

function EventOverview({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const { patch, error } = useEventPatch(event)
  const planItems = useRecordPlanItems('event', event.id)

  return (
    <div className="space-y-8">
      {error !== null && <ErrorPanel error={error} />}
      <SummaryBlock
        value={event.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />
      <SidebarField label="Details">
        <InlineEdit
          value={event.details}
          onChange={(details) => {
            patch({ details })
          }}
          multiline
          displayClassName="not-italic normal-case text-[13px]"
          emptyLabel="Add agenda or description…"
        />
      </SidebarField>
      <PlanAttention items={planItems.records} isLoading={planItems.isLoading} />
      <LatestActivity targetType="event" targetId={event.id} />
    </div>
  )
}

function EventFields({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const { patch, error } = useEventPatch(event)

  return (
    <div className="space-y-4">
      {error !== null && <ErrorPanel error={error} />}
      <CustomFieldsPanel
        objectType="event"
        values={event.customFields}
        onPatch={(customFields) => {
          patch({ customFields })
        }}
      />
    </div>
  )
}

function EventSidebar({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const { patch, error } = useEventPatch(event)
  const members = useMembers()

  return (
    <section className="rounded-md border border-border p-3">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <div className="mb-2">
        <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
          Status
        </div>
        <InlineEdit
          value={event.status}
          onChange={(status) => {
            patch({ status: status as EventStatus })
          }}
          options={EVENT_STATUSES.map((status) => ({
            value: status,
            label: EVENT_STATUS_LABELS[status],
          }))}
          display={
            <Chip tone={STATUS_TONES[event.status]}>
              <span className="text-[10px]">{EVENT_STATUS_LABELS[event.status]}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>
      <SidebarField label="Format">
        <InlineEdit
          value={event.format}
          onChange={(format) => {
            patch({ format: format as EventFormat })
          }}
          options={EVENT_FORMATS.map((format) => ({
            value: format,
            label: EVENT_FORMAT_LABELS[format],
          }))}
          displayClassName="not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Starts">
        <InlineEdit
          value={toDatetimeLocal(event.startsAt)}
          onChange={(startsAt) => {
            if (startsAt.length === 0) {
              return
            }

            patch({ startsAt: new Date(startsAt) })
          }}
          type="datetime-local"
          display={formatDateTime(event.startsAt, event.timezone)}
          displayClassName="not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Ends">
        <InlineEdit
          value={toDatetimeLocal(event.endsAt)}
          onChange={(endsAt) => {
            if (endsAt.length === 0) {
              return
            }

            patch({ endsAt: new Date(endsAt) })
          }}
          type="datetime-local"
          display={formatDateTime(event.endsAt, event.timezone)}
          displayClassName="not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Timezone">
        <InlineEdit
          value={event.timezone}
          onChange={(timezone) => {
            patch({ timezone })
          }}
          displayClassName="not-italic text-[12px]"
          emptyLabel="Set timezone…"
        />
      </SidebarField>
      <SidebarField label="Location">
        <InlineEdit
          value={event.location}
          onChange={(location) => {
            patch({ location })
          }}
          displayClassName="not-italic text-[12px]"
          emptyLabel="Add venue or Online…"
        />
      </SidebarField>
      <SidebarField label="Meeting URL">
        <InlineEdit
          value={event.meetingUrl ?? ''}
          onChange={(meetingUrl) => {
            patch({ meetingUrl: meetingUrl.length > 0 ? meetingUrl : null })
          }}
          type="url"
          displayClassName="not-italic text-[12px]"
          emptyLabel="Add meeting URL…"
        />
      </SidebarField>
      <SidebarField label="Owner">
        <EntitySearch
          options={members.members.map((member) => ({
            id: member.id,
            label: member.name,
            meta: member.email,
          }))}
          value={event.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId: ownerId.length > 0 ? ownerId : null })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={event.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            event.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {event.tags.map((tag) => (
                  <Chip key={tag}>
                    <span className="text-[10px]">{tag}</span>
                  </Chip>
                ))}
              </span>
            ) : undefined
          }
          emptyLabel="Add tags…"
          displayClassName="not-italic"
        />
      </SidebarField>
    </section>
  )
}

function EventAttendees({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const attendances = useAttendances({ eventIds: [event.id], limit: 200 })
  const createAttendance = useCreateAttendance()
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')
  const [openNotesId, setOpenNotesId] = useState<string | null>(null)
  const people = usePeople({
    term: search.trim().length > 0 ? search.trim() : undefined,
  })
  const directory = usePeople({ limit: 200 })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const registered = new Set(attendances.records.map((row) => row.personId))

  function add(submitEvent: FormEvent): void {
    submitEvent.preventDefault()

    if (personId.length === 0 || registered.has(personId)) {
      return
    }

    createAttendance.run({ eventId: event.id, personId, source: 'manual' })
    setPersonId('')
    setSearch('')
  }

  return (
    <section>
      <SectionHeader title="Attendees" />
      {createAttendance.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createAttendance.error} />
        </div>
      )}
      {attendances.error !== null && <ErrorPanel error={attendances.error} />}
      {attendances.isLoading ? (
        <p className="text-[13px] text-ink-faint">Loading attendees…</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {attendances.records.length === 0 && (
            <li className="px-3 py-3 text-[13px] text-ink-faint">No attendees yet.</li>
          )}
          {attendances.records.map((row) => (
            <AttendanceRow
              key={row.id}
              attendance={row}
              personName={nameById.get(row.personId) ?? row.personId}
              notesOpen={openNotesId === row.id}
              onToggleNotes={() => {
                setOpenNotesId((current) => (current === row.id ? null : row.id))
              }}
            />
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <EntitySearch
            options={people.records
              .filter((person) => !registered.has(person.id))
              .map((person) => ({
                id: person.id,
                label: person.name,
                meta: person.email ?? undefined,
              }))}
            value={personId}
            onChange={setPersonId}
            onQueryChange={setSearch}
            placeholder="Add a person…"
            size="sm"
          />
        </div>
        <button
          type="submit"
          disabled={createAttendance.isPending || personId.length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          Register
        </button>
      </form>
    </section>
  )
}

function AttendanceRow({
  attendance,
  personName,
  notesOpen,
  onToggleNotes,
}: {
  readonly attendance: Attendance
  readonly personName: string
  readonly notesOpen: boolean
  readonly onToggleNotes: () => void
}): React.JSX.Element {
  const updateAttendance = useUpdateAttendance()
  const deleteAttendance = useDeleteAttendance()
  const error = updateAttendance.error ?? deleteAttendance.error

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/people/${attendance.personId}`}
          className="min-w-0 flex-1 text-[13px] font-medium text-accent hover:underline"
        >
          {personName}
        </Link>
        <select
          value={attendance.status}
          aria-label={`Status for ${personName}`}
          onChange={(event) => {
            updateAttendance.run({
              id: attendance.id,
              changes: { status: event.target.value as AttendanceStatus },
            })
          }}
          className="rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] outline-none focus:border-accent"
        >
          {ATTENDANCE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ATTENDANCE_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <Chip tone={ATTENDANCE_TONES[attendance.status]}>
          {ATTENDANCE_STATUS_LABELS[attendance.status]}
        </Chip>
        <span className="text-[11px] text-ink-faint">{attendance.source}</span>
        <button
          type="button"
          onClick={onToggleNotes}
          className="text-[11px] font-medium text-ink-muted hover:text-ink"
        >
          Notes
        </button>
        <button
          type="button"
          onClick={() => {
            deleteAttendance.run(attendance.id)
          }}
          className="text-[11px] font-medium text-danger hover:underline"
        >
          Remove
        </button>
      </div>
      {error !== null && (
        <div className="mt-2">
          <ErrorPanel error={error} />
        </div>
      )}
      {notesOpen && (
        <div className="mt-3">
          <NotesPanel targetType="attendance" targetId={attendance.id} />
        </div>
      )}
    </li>
  )
}

function EventAssociationsCard({ event }: { readonly event: CrmEvent }): React.JSX.Element {
  const { patch, error } = useEventPatch(event)
  const [kind, setKind] = useState<EventAssociationTargetType>('deal')
  const [pick, setPick] = useState('')
  const [search, setSearch] = useState('')
  const options = useAssociationOptions(kind, search)
  const names = useAssociationNames()
  const chosenKey = new Set(event.associations.map((row) => `${row.targetType}:${row.targetId}`))

  function add(): void {
    if (pick.length === 0 || chosenKey.has(`${kind}:${pick}`)) {
      return
    }

    patch({
      associations: [...event.associations, { targetType: kind, targetId: pick }],
    })
    setPick('')
    setSearch('')
  }

  function remove(target: EventAssociation): void {
    patch({
      associations: event.associations.filter(
        (row) => row.targetType !== target.targetType || row.targetId !== target.targetId,
      ),
    })
  }

  return (
    <section className="rounded-md border border-border p-3">
      <SectionHeader title="Linked records" />
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <ul className="mb-3 divide-y divide-border">
        {event.associations.length === 0 && (
          <li className="py-2 text-[12px] text-ink-faint">No linked records yet.</li>
        )}
        {event.associations.map((row) => {
          const route = ASSOCIATION_ROUTES[row.targetType]
          const label = names.get(`${row.targetType}:${row.targetId}`) ?? row.targetId

          return (
            <li
              key={`${row.targetType}:${row.targetId}`}
              className="flex items-center justify-between gap-2 py-2"
            >
              {route === undefined ? (
                <span className="text-[12px] text-ink">
                  {EVENT_ASSOCIATION_TARGET_TYPE_LABELS[row.targetType]} · {label}
                </span>
              ) : (
                <Link
                  to={`${route}/${row.targetId}`}
                  className="text-[12px] font-medium text-accent hover:underline"
                >
                  {EVENT_ASSOCIATION_TARGET_TYPE_LABELS[row.targetType]} · {label}
                </Link>
              )}
              <button
                type="button"
                onClick={() => {
                  remove(row)
                }}
                className="text-[11px] font-medium text-danger hover:underline"
              >
                Remove
              </button>
            </li>
          )
        })}
      </ul>
      <div className="space-y-2">
        <select
          value={kind}
          aria-label="Record type"
          onChange={(event) => {
            setKind(event.target.value as EventAssociationTargetType)
            setPick('')
            setSearch('')
          }}
          className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[12px] outline-none focus:border-accent"
        >
          {EVENT_ASSOCIATION_TARGET_TYPES.map((type) => (
            <option key={type} value={type}>
              {EVENT_ASSOCIATION_TARGET_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <EntitySearch
          options={options.filter((option) => !chosenKey.has(`${kind}:${option.id}`))}
          value={pick}
          onChange={setPick}
          onQueryChange={setSearch}
          placeholder={`Search ${EVENT_ASSOCIATION_TARGET_TYPE_LABELS[kind].toLowerCase()}s…`}
          size="sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={pick.length === 0}
          className="w-full rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          Link
        </button>
      </div>
    </section>
  )
}

interface NamedOption {
  readonly id: string
  readonly label: string
}

function useAssociationOptions(kind: EventAssociationTargetType, search: string): readonly NamedOption[] {
  const term = search.trim().length > 0 ? search.trim() : undefined
  const people = usePeople({ term }, { enabled: kind === 'person' })
  const companies = useCompanies({ term }, { enabled: kind === 'company' })
  const deals = useDeals({ term }, { enabled: kind === 'deal' })
  const opportunities = useOpportunities({ term }, { enabled: kind === 'opportunity' })
  const partnerships = usePartnerships({ term }, { enabled: kind === 'partnership' })
  const raises = useRaises({ term }, { enabled: kind === 'raise' })
  const enquiries = useEnquiries({ term }, { enabled: kind === 'enquiry' })
  const roles = useRoles({ term }, { enabled: kind === 'role' })
  const candidates = useCandidates({}, { enabled: kind === 'candidate' })
  const candidatePeople = usePeople({ limit: 200 }, { enabled: kind === 'candidate' })
  const personName = new Map(candidatePeople.records.map((person) => [person.id, person.name]))

  switch (kind) {
    case 'person':
      return people.records.map((record) => ({ id: record.id, label: record.name }))
    case 'company':
      return companies.records.map((record) => ({ id: record.id, label: record.name }))
    case 'deal':
      return deals.records.map((record) => ({ id: record.id, label: record.name }))
    case 'opportunity':
      return opportunities.records.map((record) => ({ id: record.id, label: record.name }))
    case 'partnership':
      return partnerships.records.map((record) => ({ id: record.id, label: record.name }))
    case 'raise':
      return raises.records.map((record) => ({ id: record.id, label: record.name }))
    case 'enquiry':
      return enquiries.records.map((record) => ({ id: record.id, label: record.name }))
    case 'role':
      return roles.records.map((record) => ({ id: record.id, label: record.title }))
    case 'candidate':
      return candidates.records.map((record) => ({
        id: record.id,
        label: personName.get(record.personId) ?? record.id,
      }))
  }
}

function useAssociationNames(): ReadonlyMap<string, string> {
  const people = usePeople({ limit: 200 })
  const companies = useCompanies({ limit: 200 })
  const deals = useDeals({ limit: 200 })
  const opportunities = useOpportunities({ limit: 200 })
  const partnerships = usePartnerships({ limit: 200 })
  const raises = useRaises({ limit: 200 })
  const enquiries = useEnquiries({ limit: 200 })
  const roles = useRoles({ limit: 200 })
  const candidates = useCandidates({ limit: 200 })
  const personName = new Map(people.records.map((person) => [person.id, person.name]))
  const names = new Map<string, string>()

  for (const record of people.records) {
    names.set(`person:${record.id}`, record.name)
  }

  for (const record of companies.records) {
    names.set(`company:${record.id}`, record.name)
  }

  for (const record of deals.records) {
    names.set(`deal:${record.id}`, record.name)
  }

  for (const record of opportunities.records) {
    names.set(`opportunity:${record.id}`, record.name)
  }

  for (const record of partnerships.records) {
    names.set(`partnership:${record.id}`, record.name)
  }

  for (const record of raises.records) {
    names.set(`raise:${record.id}`, record.name)
  }

  for (const record of enquiries.records) {
    names.set(`enquiry:${record.id}`, record.name)
  }

  for (const record of roles.records) {
    names.set(`role:${record.id}`, record.title)
  }

  for (const record of candidates.records) {
    names.set(`candidate:${record.id}`, personName.get(record.personId) ?? record.id)
  }

  return names
}

function toDatetimeLocal(value: Date): string {
  const pad = (digit: number): string => String(digit).padStart(2, '0')

  return `${String(value.getFullYear())}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

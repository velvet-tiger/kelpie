import { PREFERRED_CHANNELS } from '@kelpie/schemas'
import type { Person, PersonInput, PreferredChannel } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useDeletePerson, usePerson, useUpdatePerson } from '../api/resources/people.ts'
import {
  useCreatePosition,
  useDeletePosition,
  usePositions,
  useUpdatePositionTitle,
} from '../api/resources/positions.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { Chip } from '../components/Chip.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import type { RecordTabDescriptor } from '../components/RecordTabs.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import { SidebarField } from '../components/SidebarField.tsx'
import { SocialProfilesField } from '../components/SocialProfilesField.tsx'
import { PhonesField } from '../components/PhonesField.tsx'
import { SummaryBlock } from '../components/SummaryBlock.tsx'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toOptions, toTags } from './fields.ts'

/**
 * One person.
 *
 * The mockup carried eight tabs. Overview, Activity and Notes are here; the
 * remaining five read Deals, Opportunities, Partnerships, Candidates or
 * Decisions, none of which have an endpoint yet, and return with their APIs.
 * A UI module can add its own through the `person` record-tab slot.
 *
 * Influence and relationship warmth are not on this page. They are Person
 * columns in the API and fields on the mockup's own `Person` type, but the
 * mockup deliberately shows neither, and the mockup is what this page ports.
 */

const CHANNEL_OPTIONS = toOptions(PREFERRED_CHANNELS)

export function PersonDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = usePerson(id)
  const deletePerson = useDeletePerson()
  const moduleTabs = inSlotOrder(useRecordTabs('person'))
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Person" backTo="/people" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading person…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'notes', label: 'Notes' },
    ...moduleTabs.map((tab) => ({ id: tab.id, label: tab.label })),
  ]
  const active = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'overview'
  const moduleTab = moduleTabs.find((tab) => tab.id === active)

  return (
    <div className="animate-fade-in mx-auto max-w-6xl">
      <Link
        to="/people"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← People
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <PersonHeading person={record} />

          <div className="flex justify-end">
            <DeleteRecord
              recordLabel="Person"
              recordName={record.name}
              isPending={deletePerson.isPending}
              error={deletePerson.error}
              onConfirm={() => {
                deletePerson
                  .runAsync(record.id)
                  .then(() => navigate('/people'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs tabs={tabs} active={active} onChange={setActiveTab} ariaLabel="Person sections">
            {active === 'overview' && <PersonOverview person={record} />}
            {active === 'activity' && <ActivitiesPanel targetType="person" targetId={record.id} />}
            {active === 'notes' && <NotesPanel targetType="person" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'person', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <PersonSidebar person={record} />
          <PersonPositions person={record} />
        </aside>
      </div>
    </div>
  )
}

/** A committed inline edit is one `PATCH` of one field, which is what `api.md` asks for. */
function usePersonPatch(person: Person): (changes: PersonInput) => void {
  const update = useUpdatePerson()

  return (changes) => {
    update.run({ id: person.id, changes })
  }
}

function PersonHeading({ person }: { readonly person: Person }): React.JSX.Element {
  const patch = usePersonPatch(person)

  return (
    <div className="min-w-0 flex-1">
      <InlineEdit
        value={person.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled"
      />
      <div className="mt-1">
        <InlineEdit
          value={person.email ?? ''}
          onChange={(email) => {
            patch({ email: email.length > 0 ? email : null })
          }}
          type="email"
          displayClassName="text-[13px] text-ink-muted not-italic"
          emptyLabel="Add email…"
        />
      </div>
    </div>
  )
}

/**
 * The mockup's Overview is a summary, the latest activity, and the plan items
 * needing attention. The plan section waits on the Plan items API.
 */
function PersonOverview({ person }: { readonly person: Person }): React.JSX.Element {
  const patch = usePersonPatch(person)

  return (
    <div className="space-y-8">
      <SummaryBlock
        value={person.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />
      <LatestActivity targetType="person" targetId={person.id} />
    </div>
  )
}

function PersonSidebar({ person }: { readonly person: Person }): React.JSX.Element {
  const patch = usePersonPatch(person)

  return (
    <section className="rounded-md border border-border p-3">
      <SidebarField label="Preferred channel">
        <InlineEdit
          value={person.preferredChannel}
          onChange={(value) => {
            patch({ preferredChannel: value as PreferredChannel })
          }}
          options={CHANNEL_OPTIONS}
          displayClassName="capitalize not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Timezone">
        <InlineEdit
          value={person.timezone ?? ''}
          onChange={(timezone) => {
            patch({ timezone: timezone.length > 0 ? timezone : null })
          }}
          displayClassName="not-italic normal-case text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Location">
        <InlineEdit
          value={person.location ?? ''}
          onChange={(location) => {
            patch({ location: location.length > 0 ? location : null })
          }}
          displayClassName="not-italic normal-case text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Phone">
        <PhonesField
          value={person.phones}
          onChange={(phones) => {
            patch({ phones })
          }}
        />
      </SidebarField>
      <SidebarField label="Social profiles">
        <SocialProfilesField
          value={person.socialProfiles}
          onChange={(socialProfiles) => {
            patch({ socialProfiles })
          }}
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={person.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            person.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {person.tags.map((tag) => (
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

/**
 * The companies this person holds a title at.
 *
 * Two requests, not one per position: `?person_id=` on both lists is exactly the
 * filter `api.md` documents for this, and it exists so a detail page is not N+1.
 */
function PersonPositions({ person }: { readonly person: Person }): React.JSX.Element {
  const positions = usePositions({ personIds: [person.id] })
  const companies = useCompanies({ personIds: [person.id] })
  const createPosition = useCreatePosition()
  const updateTitle = useUpdatePositionTitle()
  const deletePosition = useDeletePosition()

  const [adding, setAdding] = useState(false)
  const [companyId, setCompanyId] = useState('')
  const [title, setTitle] = useState('')
  const [search, setSearch] = useState('')
  const searchable = useCompanies({ term: search.trim().length > 0 ? search.trim() : undefined })

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))
  const held = new Set(positions.records.map((position) => position.companyId))

  function reset(): void {
    setAdding(false)
    setCompanyId('')
    setTitle('')
    setSearch('')
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    if (companyId.length === 0 || title.trim().length === 0) {
      return
    }

    createPosition.run({ personId: person.id, companyId, title: title.trim() })
    reset()
  }

  return (
    <section className="rounded-md border border-border">
      <div className="border-b border-border px-3.5 py-2.5">
        <SectionHeader
          title="Positions"
          onAdd={() => {
            setAdding((current) => !current)
          }}
          addLabel="Add position"
          compact
        />
      </div>

      {createPosition.error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={createPosition.error} />
        </div>
      )}
      {deletePosition.error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={deletePosition.error} />
        </div>
      )}

      <ul className="divide-y divide-border">
        {positions.isLoading && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">Loading positions…</li>
        )}
        {!positions.isLoading && positions.records.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No positions yet.</li>
        )}
        {positions.records.map((position) => (
          <li key={position.id} className="space-y-1 px-3.5 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <Link
                to={`/companies/${position.companyId}`}
                className="text-[13px] font-medium text-ink hover:text-accent"
              >
                {companyNameById.get(position.companyId) ?? 'Unknown'}
              </Link>
              <button
                type="button"
                onClick={() => {
                  deletePosition.run(position.id)
                }}
                className="text-[11px] font-medium text-danger hover:underline"
              >
                Remove
              </button>
            </div>
            <InlineEdit
              value={position.title}
              onChange={(next) => {
                updateTitle.run({ id: position.id, changes: { title: next } })
              }}
              displayClassName="not-italic text-[12px]"
              emptyLabel="Add position title…"
            />
          </li>
        ))}
      </ul>

      {adding && (
        <form onSubmit={submit} className="space-y-2 border-t border-border bg-surface px-3.5 py-3">
          <EntitySearch
            options={searchable.records
              .filter((company) => !held.has(company.id))
              .map((company) => ({
                id: company.id,
                label: company.name,
                meta: company.domain ?? undefined,
              }))}
            value={companyId}
            onChange={setCompanyId}
            onQueryChange={setSearch}
            placeholder="Search companies…"
            emptyMessage="No companies match"
            required
          />
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
            }}
            placeholder="Position title"
            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[12px] outline-none focus:border-accent"
            required
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover"
            >
              Add
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

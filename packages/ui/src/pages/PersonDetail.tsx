import { IN_PROCESS, PREFERRED_CHANNELS } from '@kelpie/schemas'
import type { Candidate, Person, PersonInput, PreferredChannel } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCandidates } from '../api/resources/candidates.ts'
import { useCompanies } from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { usePartnerships } from '../api/resources/partnerships.ts'
import { useDeletePerson, usePerson, useUpdatePerson } from '../api/resources/people.ts'
import {
  useCreatePosition,
  useDeletePosition,
  usePositions,
  useUpdatePositionTitle,
} from '../api/resources/positions.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
import { RelatedPlanAttention } from '../components/PlanAttention.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { ListsPanel } from '../components/ListsPanel.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import type { RecordTabDescriptor } from '../components/RecordTabs.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import { SidebarField } from '../components/SidebarField.tsx'
import { SocialProfilesField } from '../components/SocialProfilesField.tsx'
import { PhonesField } from '../components/PhonesField.tsx'
import { SummaryBlock } from '../components/SummaryBlock.tsx'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import {
  CandidateReferrerField,
  CandidateStageField,
  CandidateStatusField,
} from './candidateFields.tsx'
import { toOptions, toTags } from './fields.ts'
import { usePersonNames, useRoleTitles } from './hiringDirectory.ts'

/**
 * One person.
 *
 * The mockup carried eight tabs. Overview, Activity, Notes, Decisions and Hiring
 * are here; the remaining three read Deals, Opportunities or Partnerships, and
 * return with their pages. A UI module can add its own through the `person`
 * record-tab slot.
 *
 * Hiring appears only when this person is up for a role, which is the mockup's
 * rule: a Person carries no hiring fields, so with no candidacy there is nothing
 * for the tab to hold.
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
  const candidacies = useCandidates({ personIds: id === undefined ? [] : [id] }, {
    enabled: id !== undefined,
  })

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
    ...(candidacies.records.length === 0
      ? []
      : [{ id: 'hiring', label: 'Hiring', count: candidacies.records.length }]),
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
        to="/people"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← People
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <PersonHeading person={record} />

          <div className="flex justify-end gap-2">
            <AgentTasks targetType="person" targetId={record.id} targetLabel={record.name} />
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
            {active === 'hiring' && (
              <PersonHiring candidacies={candidacies.records} personName={record.name} />
            )}
            {active === 'notes' && <NotesPanel targetType="person" targetId={record.id} />}
            {active === 'decisions' && <DecisionsPanel targetType="person" targetId={record.id} />}
            {active === 'lists' && <ListsPanel targetType="person" targetId={record.id} />}
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
function usePersonPatch(person: Person): PatchResult<PersonInput> {
  return usePatch(useUpdatePerson, person)
}

function PersonHeading({ person }: { readonly person: Person }): React.JSX.Element {
  const { patch, error } = usePersonPatch(person)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
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
 * A summary, the plan items needing attention, and the latest activity.
 *
 * The plan rolls up from the deals and partnerships this person is on, the
 * mockup's whole roll-up for a person.
 */
function PersonOverview({ person }: { readonly person: Person }): React.JSX.Element {
  const { patch, error } = usePersonPatch(person)
  const deals = useDeals({ personIds: [person.id] })
  const partnerships = usePartnerships({ personIds: [person.id] })

  return (
    <div className="space-y-8">
      {error !== null && <ErrorPanel error={error} />}
      <SummaryBlock
        value={person.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />
      <RelatedPlanAttention
        deals={deals.records}
        partnerships={partnerships.records}
        isLoading={deals.isLoading || partnerships.isLoading}
      />
      <LatestActivity targetType="person" targetId={person.id} />
    </div>
  )
}

/**
 * Every role this person is up for, one card each.
 *
 * The full notes panel rather than the Role page's single note: an interview
 * note belongs to the candidacy, and this is the page where the reader wants all
 * of them rather than the latest one. That split is the mockup's.
 */
function PersonHiring({
  candidacies,
  personName,
}: {
  readonly candidacies: readonly Candidate[]
  readonly personName: string
}): React.JSX.Element {
  const roles = useRoleTitles()
  const names = usePersonNames()

  return (
    <section>
      <SectionHeader title="Hiring" />
      <ul className="space-y-4">
        {candidacies.map((candidate) => (
          <li key={candidate.id} className="rounded-md border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                to={`/hiring/${candidate.roleId}`}
                className="text-[14px] font-medium text-ink hover:text-accent"
              >
                {roles.titleFor(candidate.roleId) ?? candidate.roleId}
              </Link>
              <AgentTasks
                targetType="candidate"
                targetId={candidate.id}
                targetLabel={`${personName} · ${roles.titleFor(candidate.roleId) ?? candidate.roleId}`}
                compact
              />
            </div>

            <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-3">
              <div>
                <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                  Status
                </div>
                <CandidateStatusField candidate={candidate} plain />
              </div>
              <div>
                {candidate.status === IN_PROCESS && (
                  <>
                    <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                      Stage
                    </div>
                    <CandidateStageField candidate={candidate} plain />
                  </>
                )}
              </div>
              <div>
                <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                  Referrer
                </div>
                <CandidateReferrerField
                  candidate={candidate}
                  referrerName={
                    candidate.referrerPersonId === null
                      ? undefined
                      : names.nameFor(candidate.referrerPersonId)
                  }
                />
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <NotesPanel targetType="candidate" targetId={candidate.id} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PersonSidebar({ person }: { readonly person: Person }): React.JSX.Element {
  const { patch, error } = usePersonPatch(person)

  return (
    <section className="rounded-md border border-border p-3">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
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

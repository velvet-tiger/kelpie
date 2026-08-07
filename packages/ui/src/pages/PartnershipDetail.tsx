import type { Partnership, PartnershipInput, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useCompanies, useCompany } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import {
  useDeletePartnership,
  usePartnership,
  useUpdatePartnership,
} from '../api/resources/partnerships.ts'
import { usePeople } from '../api/resources/people.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { useRecordPlanItems } from '../api/resources/planItems.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
import { PlanAttention } from '../components/PlanAttention.tsx'
import { PlanPanel } from '../components/PlanPanel.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import type { RecordTabDescriptor } from '../components/RecordTabs.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import { SidebarField } from '../components/SidebarField.tsx'
import { SummaryBlock } from '../components/SummaryBlock.tsx'
import { formatDay } from '../lib/dates.ts'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toTags } from './fields.ts'

/**
 * One partnership.
 *
 * The same shape as `DealDetail`: the mockup's key-people tab renders as an
 * aside card instead, the Deal contacts precedent, and goals, success and the
 * next touchpoint sit in the sidebar as the mockup draws them. A UI module can
 * add its own tab through the `partnership` record-tab slot.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  active: 'success',
  exploring: 'accent',
  paused: 'warning',
}

export function PartnershipDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = usePartnership(id)
  const deletePartnership = useDeletePartnership()
  const moduleTabs = inSlotOrder(useRecordTabs('partnership'))
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Partnership" backTo="/partnerships" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading partnership…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'plan', label: 'Plan' },
    { id: 'activity', label: 'Activity' },
    { id: 'notes', label: 'Notes' },
    { id: 'decisions', label: 'Decisions' },
    ...moduleTabs.map((tab) => ({ id: tab.id, label: tab.label })),
  ]
  const active = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'overview'
  const moduleTab = moduleTabs.find((tab) => tab.id === active)

  return (
    <div className="animate-fade-in mx-auto max-w-6xl">
      <Link
        to="/partnerships"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Partnerships
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <PartnershipHeading partnership={record} />

          <div className="flex justify-end gap-2">
            <AgentTasks targetType="partnership" targetId={record.id} targetLabel={record.name} />
            <DeleteRecord
              recordLabel="Partnership"
              recordName={record.name}
              isPending={deletePartnership.isPending}
              error={deletePartnership.error}
              onConfirm={() => {
                deletePartnership
                  .runAsync(record.id)
                  .then(() => navigate('/partnerships'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Partnership sections"
          >
            {active === 'overview' && <PartnershipOverview partnership={record} />}
            {active === 'plan' && <PlanPanel targetType="partnership" targetId={record.id} />}
            {active === 'activity' && (
              <ActivitiesPanel targetType="partnership" targetId={record.id} />
            )}
            {active === 'notes' && <NotesPanel targetType="partnership" targetId={record.id} />}
            {active === 'decisions' && (
              <DecisionsPanel targetType="partnership" targetId={record.id} />
            )}
            {moduleTab?.render({ objectType: 'partnership', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <PartnershipSidebar partnership={record} />
          <PartnershipKeyPeople partnership={record} />
        </aside>
      </div>
    </div>
  )
}

function usePartnershipPatch(partnership: Partnership): (changes: PartnershipInput) => void {
  const update = useUpdatePartnership()

  return (changes) => {
    update.run({ id: partnership.id, changes })
  }
}

function PartnershipHeading({
  partnership,
}: {
  readonly partnership: Partnership
}): React.JSX.Element {
  const patch = usePartnershipPatch(partnership)

  return (
    <div className="min-w-0 flex-1">
      <InlineEdit
        value={partnership.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled partnership"
      />
      <div className="mt-1">
        <InlineEdit
          value={partnership.kind}
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

/** A summary, the plan items needing attention, and the latest activity. */
function PartnershipOverview({
  partnership,
}: {
  readonly partnership: Partnership
}): React.JSX.Element {
  const patch = usePartnershipPatch(partnership)
  const planItems = useRecordPlanItems('partnership', partnership.id)

  return (
    <div className="space-y-8">
      <SummaryBlock
        value={partnership.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />

      <PlanAttention items={planItems.records} isLoading={planItems.isLoading} />

      <LatestActivity targetType="partnership" targetId={partnership.id} />
    </div>
  )
}

function PartnershipSidebar({
  partnership,
}: {
  readonly partnership: Partnership
}): React.JSX.Element {
  const patch = usePartnershipPatch(partnership)
  const stages = usePipelineStages('partnership')
  const members = useMembers()
  const currentCompany = useCompany(partnership.companyId)

  const [companySearch, setCompanySearch] = useState('')
  const searchableCompanies = useCompanies({
    term: companySearch.trim().length > 0 ? companySearch.trim() : undefined,
  })

  const orderedStages = [...stages.records].sort(
    (a: PipelineStage, b: PipelineStage) => a.sortOrder - b.sortOrder,
  )
  const currentStage = orderedStages.find((stage) => stage.id === partnership.stageId)

  // The selected company must be in the option list or the picker shows nothing,
  // and a search that filtered it out would drop it from view.
  const companyOptions = [
    ...(currentCompany.record === undefined
      ? []
      : [{ id: currentCompany.record.id, label: currentCompany.record.name }]),
    ...searchableCompanies.records
      .filter((company) => company.id !== partnership.companyId)
      .map((company) => ({
        id: company.id,
        label: company.name,
        meta: company.domain ?? undefined,
      })),
  ]

  return (
    <section className="rounded-md border border-border p-3">
      <div className="mb-2">
        <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
          Status
        </div>
        <InlineEdit
          value={partnership.stageId}
          onChange={(stageId) => {
            patch({ stageId })
          }}
          options={orderedStages.map((stage) => ({ value: stage.id, label: stage.label }))}
          display={
            <Chip tone={STAGE_TONES[currentStage?.slug ?? ''] ?? 'accent'}>
              <span className="text-[10px]">{currentStage?.label ?? partnership.stageId}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Company">
        <EntitySearch
          options={companyOptions}
          value={partnership.companyId}
          onChange={(companyId) => {
            patch({ companyId })
          }}
          onQueryChange={setCompanySearch}
          placeholder="Search companies…"
          size="sm"
        />
        {currentCompany.record !== undefined && (
          <Link
            to={`/companies/${currentCompany.record.id}`}
            className="mt-1 inline-block text-[11px] text-accent hover:underline"
          >
            Open company
          </Link>
        )}
      </SidebarField>
      <SidebarField label="Owner">
        <EntitySearch
          options={members.members.map((member) => ({
            id: member.id,
            label: member.name,
            meta: member.email,
          }))}
          value={partnership.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Next touchpoint">
        <InlineEdit
          value={partnership.nextTouchpoint ?? ''}
          onChange={(nextTouchpoint) => {
            patch({ nextTouchpoint: nextTouchpoint.length > 0 ? nextTouchpoint : null })
          }}
          type="date"
          displayClassName="not-italic text-[12px]"
          display={
            partnership.nextTouchpoint === null ? undefined : formatDay(partnership.nextTouchpoint)
          }
          emptyLabel="Set touchpoint…"
        />
      </SidebarField>
      <SidebarField label="Goals">
        <InlineEdit
          value={partnership.goals}
          onChange={(goals) => {
            patch({ goals })
          }}
          multiline
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add…"
        />
      </SidebarField>
      <SidebarField label="Success looks like">
        <InlineEdit
          value={partnership.successLooksLike}
          onChange={(successLooksLike) => {
            patch({ successLooksLike })
          }}
          multiline
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add…"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={partnership.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            partnership.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {partnership.tags.map((tag) => (
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

/** The key people on the partnership, linked and unlinked by replacing `person_ids`. */
function PartnershipKeyPeople({
  partnership,
}: {
  readonly partnership: Partnership
}): React.JSX.Element {
  const patch = usePartnershipPatch(partnership)
  const update = useUpdatePartnership()

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')

  // No `?id=` filter exists on people, so names come from the directory's first
  // page. Past it, a key person renders by id rather than silently vanishing.
  const directory = usePeople({ limit: 200 })
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const linked = new Set(partnership.personIds)

  function reset(): void {
    setAdding(false)
    setPersonId('')
    setSearch('')
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    if (personId.length === 0 || linked.has(personId)) {
      return
    }

    patch({ personIds: [...partnership.personIds, personId] })
    reset()
  }

  return (
    <section className="rounded-md border border-border">
      <div className="border-b border-border px-3.5 py-2.5">
        <SectionHeader
          title="Key people"
          onAdd={() => {
            setAdding((current) => !current)
          }}
          addLabel="Add person"
          compact
        />
      </div>

      {update.error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={update.error} />
        </div>
      )}

      <ul className="divide-y divide-border">
        {partnership.personIds.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No key people yet.</li>
        )}
        {partnership.personIds.map((linkedPersonId) => (
          <li
            key={linkedPersonId}
            className="flex items-start justify-between gap-2 px-3.5 py-2.5"
          >
            <Link
              to={`/people/${linkedPersonId}`}
              className="text-[13px] font-medium text-ink hover:text-accent"
            >
              {nameById.get(linkedPersonId) ?? linkedPersonId}
            </Link>
            <button
              type="button"
              onClick={() => {
                patch({
                  personIds: partnership.personIds.filter(
                    (candidate) => candidate !== linkedPersonId,
                  ),
                })
              }}
              className="text-[11px] font-medium text-danger hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <form onSubmit={submit} className="space-y-2 border-t border-border bg-surface px-3.5 py-3">
          <EntitySearch
            options={searchable.records
              .filter((person) => !linked.has(person.id))
              .map((person) => ({
                id: person.id,
                label: person.name,
                meta: person.email ?? undefined,
              }))}
            value={personId}
            onChange={setPersonId}
            onQueryChange={setSearch}
            placeholder="Search people…"
            emptyMessage="No people match"
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

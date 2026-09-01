import type { Opportunity, OpportunityInput, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCompanies, useCompany } from '../api/resources/companies.ts'
import {
  detailPathForPipelineKind,
  useConvertPipelineRecord,
} from '../api/resources/conversions.ts'
import { useFormSubmissionsForRecord } from '../api/resources/forms.ts'
import { useMembers } from '../api/resources/members.ts'
import {
  useDeleteOpportunity,
  useOpportunity,
  useUpdateOpportunity,
} from '../api/resources/opportunities.ts'
import { usePeople } from '../api/resources/people.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { useRecordPlanItems } from '../api/resources/planItems.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { ConvertRecordAction, ConvertRecordButton } from '../components/ConvertRecordDialog.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { FormsPanel } from '../components/FormsPanel.tsx'
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
import { formatDay } from '../lib/dates.ts'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toTags } from './fields.ts'

/**
 * One opportunity.
 *
 * The same shape as `DealDetail` minus what an opportunity does not have: no
 * value, and a company that may be absent. People attach through `person_links`
 * the same way they do on a deal, and they are shown in the same contacts
 * section in the aside. A UI module can add its own tab through the
 * `opportunity` record-tab slot.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  won: 'success',
  passed: 'danger',
}

export function OpportunityDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useOpportunity(id)
  const convertRecord = useConvertPipelineRecord('opportunity')
  const deleteOpportunity = useDeleteOpportunity()
  const moduleTabs = inSlotOrder(useRecordTabs('opportunity'))
  const hasCustomFields = useHasCustomFields('opportunity')
  const [activeTab, setActiveTab] = useState('overview')
  const [showConvert, setShowConvert] = useState(false)
  const formSubmissions = useFormSubmissionsForRecord('opportunity', id)

  if (isNotFound) {
    return <NotFoundPanel label="Opportunity" backTo="/opportunities" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading opportunity…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
    ...(hasCustomFields ? [{ id: 'fields', label: 'Fields' }] : []),
    { id: 'plan', label: 'Plan' },
    { id: 'activity', label: 'Activity' },
    { id: 'notes', label: 'Notes' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'lists', label: 'Lists' },
    ...(formSubmissions.records.length === 0
      ? []
      : [{ id: 'forms', label: 'Forms', count: formSubmissions.records.length }]),
    ...moduleTabs.map((tab) => ({ id: tab.id, label: tab.label })),
  ]
  const active = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'overview'
  const moduleTab = moduleTabs.find((tab) => tab.id === active)
  const convertedTo = record.convertedTo

  return (
    <div className="animate-fade-in mx-auto max-w-6xl">
      <Link
        to="/opportunities"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Opportunities
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <OpportunityHeading opportunity={record} />

          <div className="flex justify-end gap-2">
            <ConvertRecordButton
              convertedTo={convertedTo}
              convert={convertRecord}
              onOpenDialog={() => {
                setShowConvert(true)
              }}
            />
            <AgentTasks targetType="opportunity" targetId={record.id} targetLabel={record.name} />
            <DeleteRecord
              recordLabel="Opportunity"
              recordName={record.name}
              isPending={deleteOpportunity.isPending}
              error={deleteOpportunity.error}
              onConfirm={() => {
                deleteOpportunity
                  .runAsync(record.id)
                  .then(() => navigate('/opportunities'))
                  .catch(() => undefined)
              }}
            />
          </div>

          {convertRecord.error !== null && <ErrorPanel error={convertRecord.error} />}
          <ConvertRecordAction
            sourceKind="opportunity"
            recordId={record.id}
            recordName={record.name}
            companyId={record.companyId}
            convertedTo={convertedTo}
            convert={convertRecord}
            showDialog={showConvert}
            onOpenDialog={() => {
              setShowConvert(true)
            }}
            onCloseDialog={() => {
              setShowConvert(false)
            }}
            onConverted={(created, targetType) => {
              navigate(detailPathForPipelineKind(targetType, created.id))
            }}
          />

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Opportunity sections"
          >
            {active === 'overview' && <OpportunityOverview opportunity={record} />}
            {active === 'fields' && <OpportunityFields opportunity={record} />}
            {active === 'plan' && <PlanPanel targetType="opportunity" targetId={record.id} />}
            {active === 'activity' && (
              <ActivitiesPanel targetType="opportunity" targetId={record.id} />
            )}
            {active === 'notes' && <NotesPanel targetType="opportunity" targetId={record.id} />}
            {active === 'decisions' && (
              <DecisionsPanel targetType="opportunity" targetId={record.id} />
            )}
            {active === 'lists' && <ListsPanel targetType="opportunity" targetId={record.id} />}
            {active === 'forms' && <FormsPanel targetType="opportunity" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'opportunity', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <OpportunitySidebar opportunity={record} />
          <OpportunityContacts opportunity={record} />
        </aside>
      </div>
    </div>
  )
}

function useOpportunityPatch(opportunity: Opportunity): PatchResult<OpportunityInput> {
  return usePatch(useUpdateOpportunity, opportunity)
}

function OpportunityHeading({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const { patch, error } = useOpportunityPatch(opportunity)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={opportunity.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled opportunity"
      />
      <div className="mt-1">
        <InlineEdit
          value={opportunity.kind}
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
function OpportunityOverview({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const { patch, error } = useOpportunityPatch(opportunity)
  const planItems = useRecordPlanItems('opportunity', opportunity.id)

  return (
    <div className="space-y-8">
      {error !== null && <ErrorPanel error={error} />}
      <SummaryBlock
        value={opportunity.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />

      <PlanAttention items={planItems.records} isLoading={planItems.isLoading} />

      <LatestActivity targetType="opportunity" targetId={opportunity.id} />
    </div>
  )
}

function OpportunitySidebar({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const { patch, error } = useOpportunityPatch(opportunity)
  const stages = usePipelineStages('opportunity')
  const members = useMembers()
  const currentCompany = useCompany(opportunity.companyId ?? undefined)

  const [companySearch, setCompanySearch] = useState('')
  const searchableCompanies = useCompanies({
    term: companySearch.trim().length > 0 ? companySearch.trim() : undefined,
  })

  const orderedStages = [...stages.records].sort(
    (a: PipelineStage, b: PipelineStage) => a.sortOrder - b.sortOrder,
  )
  const currentStage = orderedStages.find((stage) => stage.id === opportunity.stageId)

  // The selected company must be in the option list or the picker shows nothing,
  // and a search that filtered it out would drop it from view.
  const companyOptions = [
    ...(currentCompany.record === undefined
      ? []
      : [{ id: currentCompany.record.id, label: currentCompany.record.name }]),
    ...searchableCompanies.records
      .filter((company) => company.id !== opportunity.companyId)
      .map((company) => ({
        id: company.id,
        label: company.name,
        meta: company.domain ?? undefined,
      })),
  ]

  return (
    <section className="rounded-md border border-border p-3">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <div className="mb-2">
        <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
          Stage
        </div>
        <InlineEdit
          value={opportunity.stageId}
          onChange={(stageId) => {
            patch({ stageId })
          }}
          options={orderedStages.map((stage) => ({ value: stage.id, label: stage.label }))}
          display={
            <Chip tone={STAGE_TONES[currentStage?.slug ?? ''] ?? 'accent'}>
              <span className="text-[10px]">{currentStage?.label ?? opportunity.stageId}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Target date">
        <InlineEdit
          value={opportunity.expectedClose ?? ''}
          onChange={(expectedClose) => {
            patch({ expectedClose: expectedClose.length > 0 ? expectedClose : null })
          }}
          type="date"
          displayClassName="not-italic text-[12px]"
          display={
            opportunity.expectedClose === null ? undefined : formatDay(opportunity.expectedClose)
          }
          emptyLabel="Set target date…"
        />
      </SidebarField>
      <SidebarField label="Organisation">
        <EntitySearch
          options={companyOptions}
          value={opportunity.companyId ?? ''}
          onChange={(companyId) => {
            patch({ companyId: companyId.length > 0 ? companyId : null })
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
          value={opportunity.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={opportunity.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            opportunity.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {opportunity.tags.map((tag) => (
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

function OpportunityFields({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const { patch, error } = useOpportunityPatch(opportunity)
  return (
    <div className="space-y-4">
      {error !== null && <ErrorPanel error={error} />}
      <CustomFieldsPanel
        objectType="opportunity"
        values={opportunity.customFields}
        onPatch={(customFields) => {
          patch({ customFields })
        }}
      />
    </div>
  )
}

/** The people on the opportunity, linked and unlinked by replacing `person_ids`. */
function OpportunityContacts({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const { patch, error } = useOpportunityPatch(opportunity)

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')

  // No `?id=` filter exists on people, so names come from the directory's first
  // page. Past it, a contact renders by id rather than silently vanishing.
  const directory = usePeople({ limit: 200 })
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const linked = new Set(opportunity.personIds)

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

    patch({ personIds: [...opportunity.personIds, personId] })
    reset()
  }

  return (
    <section className="rounded-md border border-border">
      <div className="border-b border-border px-3.5 py-2.5">
        <SectionHeader
          title="Contacts"
          onAdd={() => {
            setAdding((current) => !current)
          }}
          addLabel="Add contact"
          compact
        />
      </div>

      {error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={error} />
        </div>
      )}

      <ul className="divide-y divide-border">
        {opportunity.personIds.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No contacts yet.</li>
        )}
        {opportunity.personIds.map((linkedPersonId) => (
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
                  personIds: opportunity.personIds.filter(
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

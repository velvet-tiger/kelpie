import type { Enquiry, EnquiryInput, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCompanies, useCompany } from '../api/resources/companies.ts'
import {
  useConvertEnquiry,
  useDeleteEnquiry,
  useEnquiry,
  useUpdateEnquiry,
} from '../api/resources/enquiries.ts'
import { useFormSubmissionsForRecord } from '../api/resources/forms.ts'
import { useMembers } from '../api/resources/members.ts'
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
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toTags } from './fields.ts'

/**
 * One enquiry.
 *
 * Same shape as `OpportunityDetail` minus the target date, plus a
 * Convert-to-Deal action that becomes a link to the created deal once the
 * enquiry has been converted.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  new: 'accent',
  in_progress: 'warning',
  closed: 'neutral',
}

export function EnquiryDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useEnquiry(id)
  const deleteEnquiry = useDeleteEnquiry()
  const convertEnquiry = useConvertEnquiry()
  const moduleTabs = inSlotOrder(useRecordTabs('enquiry'))
  const hasCustomFields = useHasCustomFields('enquiry')
  const [activeTab, setActiveTab] = useState('overview')
  const [showConvert, setShowConvert] = useState(false)
  const formSubmissions = useFormSubmissionsForRecord('enquiry', id)

  if (isNotFound) {
    return <NotFoundPanel label="Enquiry" backTo="/enquiries" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading enquiry…" />
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

  const convertBlockedReason =
    record.convertedDealId !== null
      ? null
      : record.companyId === null
        ? 'Link a company first'
        : null

  return (
    <div className="animate-fade-in mx-auto max-w-6xl">
      <Link
        to="/enquiries"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Enquiries
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <EnquiryHeading enquiry={record} />

          <div className="flex justify-end gap-2">
            {record.convertedDealId === null ? (
              <button
                type="button"
                onClick={() => {
                  if (convertBlockedReason === null) {
                    setShowConvert(true)
                  }
                }}
                disabled={convertBlockedReason !== null || convertEnquiry.isPending}
                title={convertBlockedReason ?? undefined}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink-muted transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-ink-muted"
              >
                Convert to deal
              </button>
            ) : (
              <Link
                to={`/deals/${record.convertedDealId}`}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-accent transition hover:border-accent hover:underline"
              >
                Converted — view deal
              </Link>
            )}
            <AgentTasks targetType="enquiry" targetId={record.id} targetLabel={record.name} />
            <DeleteRecord
              recordLabel="Enquiry"
              recordName={record.name}
              isPending={deleteEnquiry.isPending}
              error={deleteEnquiry.error}
              onConfirm={() => {
                deleteEnquiry
                  .runAsync(record.id)
                  .then(() => navigate('/enquiries'))
                  .catch(() => undefined)
              }}
            />
          </div>

          {convertEnquiry.error !== null && <ErrorPanel error={convertEnquiry.error} />}
          {showConvert && (
            <ConvertConfirm
              enquiry={record}
              isPending={convertEnquiry.isPending}
              onCancel={() => {
                setShowConvert(false)
              }}
              onConfirm={() => {
                convertEnquiry
                  .runAsync(record.id)
                  .then((deal) => {
                    setShowConvert(false)

                    return navigate(`/deals/${deal.id}`)
                  })
                  .catch(() => undefined)
              }}
            />
          )}

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Enquiry sections"
          >
            {active === 'overview' && <EnquiryOverview enquiry={record} />}
            {active === 'fields' && <EnquiryFields enquiry={record} />}
            {active === 'plan' && <PlanPanel targetType="enquiry" targetId={record.id} />}
            {active === 'activity' && (
              <ActivitiesPanel targetType="enquiry" targetId={record.id} />
            )}
            {active === 'notes' && <NotesPanel targetType="enquiry" targetId={record.id} />}
            {active === 'decisions' && (
              <DecisionsPanel targetType="enquiry" targetId={record.id} />
            )}
            {active === 'lists' && <ListsPanel targetType="enquiry" targetId={record.id} />}
            {active === 'forms' && <FormsPanel targetType="enquiry" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'enquiry', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <EnquirySidebar enquiry={record} />
          <EnquiryContacts enquiry={record} />
        </aside>
      </div>
    </div>
  )
}

function useEnquiryPatch(enquiry: Enquiry): PatchResult<EnquiryInput> {
  return usePatch(useUpdateEnquiry, enquiry)
}

function EnquiryHeading({ enquiry }: { readonly enquiry: Enquiry }): React.JSX.Element {
  const { patch, error } = useEnquiryPatch(enquiry)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={enquiry.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled enquiry"
      />
      <div className="mt-1">
        <InlineEdit
          value={enquiry.source}
          onChange={(source) => {
            patch({ source })
          }}
          displayClassName="text-[13px] text-ink-muted not-italic"
          emptyLabel="Add source…"
        />
      </div>
    </div>
  )
}

function EnquiryOverview({ enquiry }: { readonly enquiry: Enquiry }): React.JSX.Element {
  const { patch, error } = useEnquiryPatch(enquiry)
  const planItems = useRecordPlanItems('enquiry', enquiry.id)

  return (
    <div className="space-y-8">
      {error !== null && <ErrorPanel error={error} />}
      <SummaryBlock
        value={enquiry.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />

      <PlanAttention items={planItems.records} isLoading={planItems.isLoading} />

      <LatestActivity targetType="enquiry" targetId={enquiry.id} />
    </div>
  )
}

function EnquirySidebar({ enquiry }: { readonly enquiry: Enquiry }): React.JSX.Element {
  const { patch, error } = useEnquiryPatch(enquiry)
  const stages = usePipelineStages('enquiry')
  const members = useMembers()
  const currentCompany = useCompany(enquiry.companyId ?? undefined)

  const [companySearch, setCompanySearch] = useState('')
  const searchableCompanies = useCompanies({
    term: companySearch.trim().length > 0 ? companySearch.trim() : undefined,
  })

  const orderedStages = [...stages.records].sort(
    (a: PipelineStage, b: PipelineStage) => a.sortOrder - b.sortOrder,
  )
  const currentStage = orderedStages.find((stage) => stage.id === enquiry.stageId)

  const companyOptions = [
    ...(currentCompany.record === undefined
      ? []
      : [{ id: currentCompany.record.id, label: currentCompany.record.name }]),
    ...searchableCompanies.records
      .filter((company) => company.id !== enquiry.companyId)
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
          value={enquiry.stageId}
          onChange={(stageId) => {
            patch({ stageId })
          }}
          options={orderedStages.map((stage) => ({ value: stage.id, label: stage.label }))}
          display={
            <Chip tone={STAGE_TONES[currentStage?.slug ?? ''] ?? 'accent'}>
              <span className="text-[10px]">{currentStage?.label ?? enquiry.stageId}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Organisation">
        <EntitySearch
          options={companyOptions}
          value={enquiry.companyId ?? ''}
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
          value={enquiry.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={enquiry.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            enquiry.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {enquiry.tags.map((tag) => (
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

function EnquiryFields({ enquiry }: { readonly enquiry: Enquiry }): React.JSX.Element {
  const { patch, error } = useEnquiryPatch(enquiry)
  return (
    <div className="space-y-4">
      {error !== null && <ErrorPanel error={error} />}
      <CustomFieldsPanel
        objectType="enquiry"
        values={enquiry.customFields}
        onPatch={(customFields) => {
          patch({ customFields })
        }}
      />
    </div>
  )
}

function EnquiryContacts({ enquiry }: { readonly enquiry: Enquiry }): React.JSX.Element {
  const { patch, error } = useEnquiryPatch(enquiry)

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')

  const directory = usePeople({ limit: 200 })
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const linked = new Set(enquiry.personIds)

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

    patch({ personIds: [...enquiry.personIds, personId] })
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
        {enquiry.personIds.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No contacts yet.</li>
        )}
        {enquiry.personIds.map((linkedPersonId) => (
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
                  personIds: enquiry.personIds.filter(
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

function ConvertConfirm({
  enquiry,
  isPending,
  onCancel,
  onConfirm,
}: {
  readonly enquiry: Enquiry
  readonly isPending: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface-raised p-4">
      <p className="text-[13px] text-ink">
        Convert <span className="font-semibold">{enquiry.name}</span> to a Deal. This creates a new
        deal (name, company, owner and linked people carry over) and moves this enquiry to the
        first closed stage.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {isPending ? 'Converting…' : 'Convert'}
        </button>
      </div>
    </div>
  )
}

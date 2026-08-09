import type { Opportunity, OpportunityInput, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useCompanies, useCompany } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import {
  useDeleteOpportunity,
  useOpportunity,
  useUpdateOpportunity,
} from '../api/resources/opportunities.ts'
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
 * value, no contacts, and a company that may be absent. A UI module can add its
 * own tab through the `opportunity` record-tab slot.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  won: 'success',
  passed: 'danger',
}

export function OpportunityDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useOpportunity(id)
  const deleteOpportunity = useDeleteOpportunity()
  const moduleTabs = inSlotOrder(useRecordTabs('opportunity'))
  const [activeTab, setActiveTab] = useState('overview')

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
        to="/opportunities"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Opportunities
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <OpportunityHeading opportunity={record} />

          <div className="flex justify-end gap-2">
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

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Opportunity sections"
          >
            {active === 'overview' && <OpportunityOverview opportunity={record} />}
            {active === 'plan' && <PlanPanel targetType="opportunity" targetId={record.id} />}
            {active === 'activity' && (
              <ActivitiesPanel targetType="opportunity" targetId={record.id} />
            )}
            {active === 'notes' && <NotesPanel targetType="opportunity" targetId={record.id} />}
            {active === 'decisions' && (
              <DecisionsPanel targetType="opportunity" targetId={record.id} />
            )}
            {moduleTab?.render({ objectType: 'opportunity', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <OpportunitySidebar opportunity={record} />
        </aside>
      </div>
    </div>
  )
}

function useOpportunityPatch(opportunity: Opportunity): (changes: OpportunityInput) => void {
  const update = useUpdateOpportunity()

  return (changes) => {
    update.run({ id: opportunity.id, changes })
  }
}

function OpportunityHeading({
  opportunity,
}: {
  readonly opportunity: Opportunity
}): React.JSX.Element {
  const patch = useOpportunityPatch(opportunity)

  return (
    <div className="min-w-0 flex-1">
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
  const patch = useOpportunityPatch(opportunity)
  const planItems = useRecordPlanItems('opportunity', opportunity.id)

  return (
    <div className="space-y-8">
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
  const patch = useOpportunityPatch(opportunity)
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

import type { PipelineStage, Raise, RaiseInput } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCompanies, useCompany } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import { usePeople } from '../api/resources/people.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { useRecordPlanItems } from '../api/resources/planItems.ts'
import { useDeleteRaise, useRaise, useUpdateRaise } from '../api/resources/raises.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { AgentTasks } from '../components/AgentTasks.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
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
import { formatMoney } from '../lib/money.ts'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toTags } from './fields.ts'

/**
 * One raise.
 *
 * The same shape as `DealDetail`: the mockup's key-people tab renders as an
 * aside card instead, the Deal contacts precedent, and the thesis fit and pass
 * reason sit in the sidebar as the mockup draws them. The pass reason shows only
 * once the raise is passed or a reason is already recorded, the mockup's rule.
 * A UI module can add its own tab through the `raise` record-tab slot.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  closed: 'success',
  passed: 'danger',
  term_sheet: 'warning',
  diligence: 'warning',
  meeting: 'accent',
  intro: 'accent',
}

export function RaiseDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useRaise(id)
  const deleteRaise = useDeleteRaise()
  const moduleTabs = inSlotOrder(useRecordTabs('raise'))
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Raise" backTo="/fundraising" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading raise…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'plan', label: 'Plan' },
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
        to="/fundraising"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Fundraising
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <RaiseHeading raise={record} />

          <div className="flex justify-end gap-2">
            <AgentTasks targetType="raise" targetId={record.id} targetLabel={record.name} />
            <DeleteRecord
              recordLabel="Raise"
              recordName={record.name}
              isPending={deleteRaise.isPending}
              error={deleteRaise.error}
              onConfirm={() => {
                deleteRaise
                  .runAsync(record.id)
                  .then(() => navigate('/fundraising'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs tabs={tabs} active={active} onChange={setActiveTab} ariaLabel="Raise sections">
            {active === 'overview' && <RaiseOverview raise={record} />}
            {active === 'plan' && <PlanPanel targetType="raise" targetId={record.id} />}
            {active === 'activity' && <ActivitiesPanel targetType="raise" targetId={record.id} />}
            {active === 'notes' && <NotesPanel targetType="raise" targetId={record.id} />}
            {active === 'decisions' && <DecisionsPanel targetType="raise" targetId={record.id} />}
            {active === 'lists' && <ListsPanel targetType="raise" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'raise', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <RaiseSidebar raise={record} />
          <RaiseKeyPeople raise={record} />
        </aside>
      </div>
    </div>
  )
}

function useRaisePatch(raise: Raise): PatchResult<RaiseInput> {
  return usePatch(useUpdateRaise, raise)
}

function RaiseHeading({ raise }: { readonly raise: Raise }): React.JSX.Element {
  const { patch, error } = useRaisePatch(raise)
  const firm = useCompany(raise.companyId)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={raise.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled raise"
      />
      <div className="mt-1 text-[13px] text-ink-muted">
        {firm.record === undefined ? (
          'No firm'
        ) : (
          <Link to={`/companies/${firm.record.id}`} className="hover:text-accent">
            {firm.record.name}
          </Link>
        )}
      </div>
    </div>
  )
}

/** A summary, the plan items needing attention, and the latest activity. */
function RaiseOverview({ raise }: { readonly raise: Raise }): React.JSX.Element {
  const { patch, error } = useRaisePatch(raise)
  const planItems = useRecordPlanItems('raise', raise.id)

  return (
    <div className="space-y-8">
      {error !== null && <ErrorPanel error={error} />}
      <SummaryBlock
        value={raise.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />

      <PlanAttention items={planItems.records} isLoading={planItems.isLoading} />

      <LatestActivity targetType="raise" targetId={raise.id} />
    </div>
  )
}

/** Whole units in the box, cents on the wire. Blank clears the value. */
function toCheckSizeCents(raw: string): number | null | undefined {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : undefined
}

function RaiseSidebar({ raise }: { readonly raise: Raise }): React.JSX.Element {
  const { patch, error } = useRaisePatch(raise)
  const stages = usePipelineStages('raise')
  const members = useMembers()
  const currentFirm = useCompany(raise.companyId)

  const [firmSearch, setFirmSearch] = useState('')
  const searchableFirms = useCompanies({
    term: firmSearch.trim().length > 0 ? firmSearch.trim() : undefined,
  })

  const orderedStages = [...stages.records].sort(
    (a: PipelineStage, b: PipelineStage) => a.sortOrder - b.sortOrder,
  )
  const currentStage = orderedStages.find((stage) => stage.id === raise.stageId)

  // The selected firm must be in the option list or the picker shows nothing,
  // and a search that filtered it out would drop it from view.
  const firmOptions = [
    ...(currentFirm.record === undefined
      ? []
      : [{ id: currentFirm.record.id, label: currentFirm.record.name }]),
    ...searchableFirms.records
      .filter((company) => company.id !== raise.companyId)
      .map((company) => ({
        id: company.id,
        label: company.name,
        meta: company.domain ?? undefined,
      })),
  ]

  const showPassReason = currentStage?.slug === 'passed' || raise.passReason !== null

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
          value={raise.stageId}
          onChange={(stageId) => {
            patch({ stageId })
          }}
          options={orderedStages.map((stage) => ({ value: stage.id, label: stage.label }))}
          display={
            <Chip tone={STAGE_TONES[currentStage?.slug ?? ''] ?? 'accent'}>
              <span className="text-[10px]">{currentStage?.label ?? raise.stageId}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Check size">
        <InlineEdit
          value={raise.checkSizeCents === null ? '' : String(raise.checkSizeCents / 100)}
          onChange={(raw) => {
            const checkSizeCents = toCheckSizeCents(raw)

            if (checkSizeCents !== undefined) {
              patch({ checkSizeCents })
            }
          }}
          type="number"
          display={
            raise.checkSizeCents === null ? undefined : (
              <span className="font-mono text-[12px] font-medium">
                {formatMoney(raise.checkSizeCents, raise.currency)}
              </span>
            )
          }
          displayClassName="not-italic"
          emptyLabel="Set check…"
        />
      </SidebarField>
      <SidebarField label="Firm">
        <EntitySearch
          options={firmOptions}
          value={raise.companyId}
          onChange={(companyId) => {
            patch({ companyId })
          }}
          onQueryChange={setFirmSearch}
          placeholder="Search firms…"
          size="sm"
        />
        {currentFirm.record !== undefined && (
          <Link
            to={`/companies/${currentFirm.record.id}`}
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
          value={raise.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Target close">
        <InlineEdit
          value={raise.expectedClose ?? ''}
          onChange={(expectedClose) => {
            patch({ expectedClose: expectedClose.length > 0 ? expectedClose : null })
          }}
          type="date"
          displayClassName="not-italic text-[12px]"
          display={raise.expectedClose === null ? undefined : formatDay(raise.expectedClose)}
          emptyLabel="Set close…"
        />
      </SidebarField>
      <SidebarField label="Thesis fit">
        <InlineEdit
          value={raise.thesisFit}
          onChange={(thesisFit) => {
            patch({ thesisFit })
          }}
          multiline
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add…"
        />
      </SidebarField>
      {showPassReason && (
        <SidebarField label="Pass reason">
          <InlineEdit
            value={raise.passReason ?? ''}
            onChange={(passReason) => {
              patch({ passReason: passReason.length > 0 ? passReason : null })
            }}
            multiline
            displayClassName="not-italic normal-case text-[12px]"
            emptyLabel="Add reason…"
          />
        </SidebarField>
      )}
      <SidebarField label="Tags">
        <InlineEdit
          value={raise.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            raise.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {raise.tags.map((tag) => (
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

/** The key people on the raise, linked and unlinked by replacing `person_ids`. */
function RaiseKeyPeople({ raise }: { readonly raise: Raise }): React.JSX.Element {
  const { patch, error } = useRaisePatch(raise)

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')

  // No `?id=` filter exists on people, so names come from the directory's first
  // page. Past it, a key person renders by id rather than silently vanishing.
  const directory = usePeople({ limit: 200 })
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const linked = new Set(raise.personIds)

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

    patch({ personIds: [...raise.personIds, personId] })
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

      {error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={error} />
        </div>
      )}

      <ul className="divide-y divide-border">
        {raise.personIds.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No key people yet.</li>
        )}
        {raise.personIds.map((linkedPersonId) => (
          <li key={linkedPersonId} className="flex items-start justify-between gap-2 px-3.5 py-2.5">
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
                  personIds: raise.personIds.filter((candidate) => candidate !== linkedPersonId),
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

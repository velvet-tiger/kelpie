import type { Deal, DealInput, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useCompanies, useCompany } from '../api/resources/companies.ts'
import { useDeal, useDeleteDeal, useUpdateDeal } from '../api/resources/deals.ts'
import { useMembers } from '../api/resources/members.ts'
import { usePeople } from '../api/resources/people.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
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
 * One deal.
 *
 * Overview, Activity and Notes render today; the Plan and Decisions tabs wait
 * for their endpoints, as does the mockup's plan-attention block. A UI module
 * can add its own tab through the `deal` record-tab slot.
 */

const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  won: 'success',
  lost: 'danger',
}

export function DealDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useDeal(id)
  const deleteDeal = useDeleteDeal()
  const moduleTabs = inSlotOrder(useRecordTabs('deal'))
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Deal" backTo="/deals" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading deal…" />
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
        to="/deals"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Deals
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <DealHeading deal={record} />

          <div className="flex justify-end">
            <DeleteRecord
              recordLabel="Deal"
              recordName={record.name}
              isPending={deleteDeal.isPending}
              error={deleteDeal.error}
              onConfirm={() => {
                deleteDeal
                  .runAsync(record.id)
                  .then(() => navigate('/deals'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs tabs={tabs} active={active} onChange={setActiveTab} ariaLabel="Deal sections">
            {active === 'overview' && <DealOverview deal={record} />}
            {active === 'activity' && <ActivitiesPanel targetType="deal" targetId={record.id} />}
            {active === 'notes' && <NotesPanel targetType="deal" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'deal', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <DealSidebar deal={record} />
          <DealContacts deal={record} />
        </aside>
      </div>
    </div>
  )
}

function useDealPatch(deal: Deal): (changes: DealInput) => void {
  const update = useUpdateDeal()

  return (changes) => {
    update.run({ id: deal.id, changes })
  }
}

function DealHeading({ deal }: { readonly deal: Deal }): React.JSX.Element {
  const patch = useDealPatch(deal)
  const company = useCompany(deal.companyId)

  return (
    <div className="min-w-0 flex-1">
      <InlineEdit
        value={deal.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled deal"
      />
      <div className="mt-1 text-[13px] text-ink-muted">
        {company.record === undefined ? (
          '…'
        ) : (
          <Link to={`/companies/${company.record.id}`} className="hover:text-accent">
            {company.record.name}
          </Link>
        )}
      </div>
    </div>
  )
}

function DetailField({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </div>
      <div className="min-w-0 text-[13px] leading-snug text-ink">{children}</div>
    </div>
  )
}

/** Summary, the agent fields, and the latest activity. */
function DealOverview({ deal }: { readonly deal: Deal }): React.JSX.Element {
  const patch = useDealPatch(deal)

  return (
    <div className="space-y-8">
      <SummaryBlock
        value={deal.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />

      <section>
        <SectionHeader title="Details" />
        <div className="grid gap-y-4">
          <DetailField label="Why we win">
            <InlineEdit
              value={deal.whyWin}
              onChange={(whyWin) => {
                patch({ whyWin })
              }}
              multiline
              displayClassName="not-italic normal-case text-[13px]"
              emptyLabel="Add…"
            />
          </DetailField>
          <DetailField label="Risks">
            <InlineEdit
              value={deal.risks}
              onChange={(risks) => {
                patch({ risks })
              }}
              multiline
              displayClassName="not-italic normal-case text-[13px]"
              emptyLabel="Add…"
            />
          </DetailField>
          <DetailField label="Competitors">
            <InlineEdit
              value={deal.competitors.join(', ')}
              onChange={(value) => {
                patch({ competitors: toTags(value) })
              }}
              displayClassName="not-italic normal-case text-[13px]"
              emptyLabel="Add competitors…"
            />
          </DetailField>
        </div>
      </section>

      <LatestActivity targetType="deal" targetId={deal.id} />
    </div>
  )
}

/** Whole units in the box, cents on the wire. Blank clears the value. */
function toValueCents(raw: string): number | null | undefined {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return null
  }

  const parsed = Number(trimmed)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : undefined
}

function DealSidebar({ deal }: { readonly deal: Deal }): React.JSX.Element {
  const patch = useDealPatch(deal)
  const stages = usePipelineStages('deal')
  const members = useMembers()
  const currentCompany = useCompany(deal.companyId)

  const [companySearch, setCompanySearch] = useState('')
  const searchableCompanies = useCompanies({
    term: companySearch.trim().length > 0 ? companySearch.trim() : undefined,
  })

  const orderedStages = [...stages.records].sort(
    (a: PipelineStage, b: PipelineStage) => a.sortOrder - b.sortOrder,
  )
  const currentStage = orderedStages.find((stage) => stage.id === deal.stageId)

  // The selected company must be in the option list or the picker shows nothing,
  // and a search that filtered it out would drop it from view.
  const companyOptions = [
    ...(currentCompany.record === undefined
      ? []
      : [{ id: currentCompany.record.id, label: currentCompany.record.name }]),
    ...searchableCompanies.records
      .filter((company) => company.id !== deal.companyId)
      .map((company) => ({ id: company.id, label: company.name, meta: company.domain ?? undefined })),
  ]

  return (
    <section className="rounded-md border border-border p-3">
      <div className="mb-2">
        <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
          Stage
        </div>
        <InlineEdit
          value={deal.stageId}
          onChange={(stageId) => {
            patch({ stageId })
          }}
          options={orderedStages.map((stage) => ({ value: stage.id, label: stage.label }))}
          display={
            <Chip tone={STAGE_TONES[currentStage?.slug ?? ''] ?? 'accent'}>
              <span className="text-[10px]">{currentStage?.label ?? deal.stageId}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Value">
        <InlineEdit
          value={deal.valueCents === null ? '' : String(deal.valueCents / 100)}
          onChange={(raw) => {
            const valueCents = toValueCents(raw)

            if (valueCents !== undefined) {
              patch({ valueCents })
            }
          }}
          type="number"
          display={
            deal.valueCents === null ? undefined : (
              <span className="font-mono text-[12px] font-medium">
                {formatMoney(deal.valueCents, deal.currency)}
              </span>
            )
          }
          displayClassName="not-italic"
          emptyLabel="Set value…"
        />
      </SidebarField>
      <SidebarField label="Expected close">
        <InlineEdit
          value={deal.expectedClose ?? ''}
          onChange={(expectedClose) => {
            patch({ expectedClose: expectedClose.length > 0 ? expectedClose : null })
          }}
          type="date"
          displayClassName="not-italic text-[12px]"
          display={deal.expectedClose === null ? undefined : formatDay(deal.expectedClose)}
          emptyLabel="Set close date…"
        />
      </SidebarField>
      <SidebarField label="Company">
        <EntitySearch
          options={companyOptions}
          value={deal.companyId}
          onChange={(companyId) => {
            patch({ companyId })
          }}
          onQueryChange={setCompanySearch}
          placeholder="Search companies…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Owner">
        <EntitySearch
          options={members.members.map((member) => ({
            id: member.id,
            label: member.name,
            meta: member.email,
          }))}
          value={deal.ownerId ?? ''}
          onChange={(ownerId) => {
            patch({ ownerId })
          }}
          placeholder="Search owners…"
          size="sm"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={deal.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            deal.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {deal.tags.map((tag) => (
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

/** The people on the deal, linked and unlinked by replacing `person_ids`. */
function DealContacts({ deal }: { readonly deal: Deal }): React.JSX.Element {
  const patch = useDealPatch(deal)
  const update = useUpdateDeal()

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [search, setSearch] = useState('')

  // No `?id=` filter exists on people, so names come from the directory's first
  // page. Past it, a contact renders by id rather than silently vanishing.
  const directory = usePeople({ limit: 200 })
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })
  const nameById = new Map(directory.records.map((person) => [person.id, person.name]))
  const linked = new Set(deal.personIds)

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

    patch({ personIds: [...deal.personIds, personId] })
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

      {update.error !== null && (
        <div className="px-3.5 py-2">
          <ErrorPanel error={update.error} />
        </div>
      )}

      <ul className="divide-y divide-border">
        {deal.personIds.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No contacts yet.</li>
        )}
        {deal.personIds.map((linkedPersonId) => (
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
                  personIds: deal.personIds.filter((candidate) => candidate !== linkedPersonId),
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

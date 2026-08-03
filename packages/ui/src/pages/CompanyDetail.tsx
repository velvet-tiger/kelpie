import { ACCOUNT_TYPES, COMPANY_STAGES, ICP_FITS, SIZE_BANDS } from '@kelpie/schemas'
import type { AccountType, Company, CompanyInput, CompanyStage, IcpFit, SizeBand } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import {
  useCompany,
  useDeleteCompany,
  useUpdateCompany,
} from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePeople } from '../api/resources/people.ts'
import {
  useCreatePosition,
  useDeletePosition,
  usePositions,
  useUpdatePositionTitle,
} from '../api/resources/positions.ts'
import { ActivitiesPanel, LatestActivity } from '../components/ActivitiesPanel.tsx'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DecisionsPanel } from '../components/DecisionsPanel.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { NotesPanel } from '../components/NotesPanel.tsx'
import { RelatedPlanAttention } from '../components/PlanAttention.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { RecordTabs } from '../components/RecordTabs.tsx'
import type { RecordTabDescriptor } from '../components/RecordTabs.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import { SidebarField } from '../components/SidebarField.tsx'
import { SummaryBlock } from '../components/SummaryBlock.tsx'
import { useRecordTabs } from '../registry/context.ts'
import { inSlotOrder } from '../registry/registry.ts'
import { toOptions, toTags } from './fields.ts'

/**
 * One company.
 *
 * Overview, Activity, Notes and Decisions render today. As with People, the
 * tabs for Deals, Opportunities, Partnerships and Raises wait for their
 * endpoints. A UI module can add its own through the `company` record-tab slot.
 */

const STAGE_OPTIONS = toOptions(COMPANY_STAGES)
const SIZE_OPTIONS = toOptions(SIZE_BANDS)
const ACCOUNT_OPTIONS = toOptions(ACCOUNT_TYPES)
const ICP_OPTIONS = toOptions(ICP_FITS)

const ICP_TONES: Readonly<Record<IcpFit, ChipTone>> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
  unknown: 'neutral',
}

export function CompanyDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useCompany(id)
  const deleteCompany = useDeleteCompany()
  const moduleTabs = inSlotOrder(useRecordTabs('company'))
  const [activeTab, setActiveTab] = useState('overview')

  if (isNotFound) {
    return <NotFoundPanel label="Company" backTo="/companies" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading company…" />
  }

  const tabs: readonly RecordTabDescriptor<string>[] = [
    { id: 'overview', label: 'Overview' },
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
        to="/companies"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Companies
      </Link>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <CompanyHeading company={record} />

          <div className="flex justify-end">
            <DeleteRecord
              recordLabel="Company"
              recordName={record.name}
              isPending={deleteCompany.isPending}
              error={deleteCompany.error}
              onConfirm={() => {
                deleteCompany
                  .runAsync(record.id)
                  .then(() => navigate('/companies'))
                  .catch(() => undefined)
              }}
            />
          </div>

          <RecordTabs
            tabs={tabs}
            active={active}
            onChange={setActiveTab}
            ariaLabel="Company sections"
          >
            {active === 'overview' && <CompanyOverview company={record} />}
            {active === 'activity' && <ActivitiesPanel targetType="company" targetId={record.id} />}
            {active === 'notes' && <NotesPanel targetType="company" targetId={record.id} />}
            {active === 'decisions' && <DecisionsPanel targetType="company" targetId={record.id} />}
            {moduleTab?.render({ objectType: 'company', recordId: record.id })}
          </RecordTabs>
        </div>

        <aside className="space-y-4 text-[12px] lg:sticky lg:top-6">
          <CompanySidebar company={record} />
          <CompanyPeople company={record} />
        </aside>
      </div>
    </div>
  )
}

function useCompanyPatch(company: Company): (changes: CompanyInput) => void {
  const update = useUpdateCompany()

  return (changes) => {
    update.run({ id: company.id, changes })
  }
}

function CompanyHeading({ company }: { readonly company: Company }): React.JSX.Element {
  const patch = useCompanyPatch(company)

  return (
    <div className="min-w-0 flex-1">
      <InlineEdit
        value={company.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled"
      />
      <div className="mt-1">
        <InlineEdit
          value={company.domain ?? ''}
          onChange={(domain) => {
            patch({ domain: domain.length > 0 ? domain : null })
          }}
          displayClassName="text-[13px] font-mono text-ink-muted not-italic"
          emptyLabel="Add domain…"
        />
      </div>
    </div>
  )
}

/**
 * A summary, the plan items needing attention, and the latest activity.
 *
 * The plan rolls up from this company's deals and opportunities. The mockup
 * also rolls up its partnerships and raises, neither of which has an endpoint
 * yet, so nothing in the workspace can carry a plan item against one.
 */
function CompanyOverview({ company }: { readonly company: Company }): React.JSX.Element {
  const patch = useCompanyPatch(company)
  const deals = useDeals({ companyIds: [company.id] })
  const opportunities = useOpportunities({ companyIds: [company.id] })

  return (
    <div className="space-y-8">
      <SummaryBlock
        value={company.summary}
        onChange={(summary) => {
          patch({ summary })
        }}
      />
      <RelatedPlanAttention
        deals={deals.records}
        opportunities={opportunities.records}
        isLoading={deals.isLoading || opportunities.isLoading}
      />
      <LatestActivity targetType="company" targetId={company.id} />
    </div>
  )
}

function CompanySidebar({ company }: { readonly company: Company }): React.JSX.Element {
  const patch = useCompanyPatch(company)

  return (
    <section className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap gap-1">
        <InlineEdit
          value={company.accountType}
          onChange={(value) => {
            patch({ accountType: value as AccountType })
          }}
          options={ACCOUNT_OPTIONS}
          display={
            <Chip>
              <span className="text-[10px]">{company.accountType}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex capitalize"
          className="!w-auto"
        />
        <InlineEdit
          value={company.icpFit}
          onChange={(value) => {
            patch({ icpFit: value as IcpFit })
          }}
          options={ICP_OPTIONS}
          display={
            <Chip tone={ICP_TONES[company.icpFit]}>
              <span className="text-[10px]">ICP {company.icpFit}</span>
            </Chip>
          }
          displayClassName="not-italic inline-flex"
          className="!w-auto"
        />
      </div>

      <SidebarField label="Industry">
        <InlineEdit
          value={company.industry ?? ''}
          onChange={(industry) => {
            patch({ industry: industry.length > 0 ? industry : null })
          }}
          displayClassName="not-italic normal-case text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Stage">
        <InlineEdit
          value={company.stage}
          onChange={(value) => {
            patch({ stage: value as CompanyStage })
          }}
          options={STAGE_OPTIONS}
          displayClassName="capitalize not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="Size">
        <InlineEdit
          value={company.sizeBand}
          onChange={(value) => {
            patch({ sizeBand: value as SizeBand })
          }}
          options={SIZE_OPTIONS}
          displayClassName="not-italic text-[12px]"
        />
      </SidebarField>
      <SidebarField label="HQ">
        <InlineEdit
          value={company.hq ?? ''}
          onChange={(hq) => {
            patch({ hq: hq.length > 0 ? hq : null })
          }}
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add HQ…"
        />
      </SidebarField>
      <SidebarField label="Website">
        <InlineEdit
          value={company.website ?? ''}
          onChange={(website) => {
            patch({ website: website.length > 0 ? website : null })
          }}
          type="url"
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add website…"
        />
      </SidebarField>
      <SidebarField label="Tech stack">
        <InlineEdit
          value={company.techStack.join(', ')}
          onChange={(value) => {
            patch({ techStack: toTags(value) })
          }}
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add tech stack…"
        />
      </SidebarField>
      <SidebarField label="Description">
        <InlineEdit
          value={company.description}
          onChange={(description) => {
            patch({ description })
          }}
          multiline
          displayClassName="not-italic normal-case text-[12px]"
          emptyLabel="Add description…"
        />
      </SidebarField>
      <SidebarField label="Tags">
        <InlineEdit
          value={company.tags.join(', ')}
          onChange={(value) => {
            patch({ tags: toTags(value) })
          }}
          display={
            company.tags.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {company.tags.map((tag) => (
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

/** The other side of the Position link: who holds a title here. */
function CompanyPeople({ company }: { readonly company: Company }): React.JSX.Element {
  const positions = usePositions({ companyIds: [company.id] })
  const people = usePeople({ companyIds: [company.id] })
  const createPosition = useCreatePosition()
  const updateTitle = useUpdatePositionTitle()
  const deletePosition = useDeletePosition()

  const [adding, setAdding] = useState(false)
  const [personId, setPersonId] = useState('')
  const [title, setTitle] = useState('')
  const [search, setSearch] = useState('')
  const searchable = usePeople({ term: search.trim().length > 0 ? search.trim() : undefined })

  const personById = new Map(people.records.map((person) => [person.id, person]))
  const held = new Set(positions.records.map((position) => position.personId))

  function reset(): void {
    setAdding(false)
    setPersonId('')
    setTitle('')
    setSearch('')
  }

  function submit(event: FormEvent): void {
    event.preventDefault()

    if (personId.length === 0 || title.trim().length === 0) {
      return
    }

    createPosition.run({ personId, companyId: company.id, title: title.trim() })
    reset()
  }

  return (
    <section className="rounded-md border border-border">
      <div className="border-b border-border px-3.5 py-2.5">
        <SectionHeader
          title="People"
          onAdd={() => {
            setAdding((current) => !current)
          }}
          addLabel="Add person"
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
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">Loading people…</li>
        )}
        {!positions.isLoading && positions.records.length === 0 && !adding && (
          <li className="px-3.5 py-4 text-[12px] text-ink-faint">No people yet.</li>
        )}
        {positions.records.map((position) => {
          const person = personById.get(position.personId)

          return (
            <li key={position.id} className="space-y-1 px-3.5 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <Link
                  to={`/people/${position.personId}`}
                  className="text-[13px] font-medium text-ink hover:text-accent"
                >
                  {person?.name ?? 'Unknown'}
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
          )
        })}
      </ul>

      {adding && (
        <form onSubmit={submit} className="space-y-2 border-t border-border bg-surface px-3.5 py-3">
          <EntitySearch
            options={searchable.records
              .filter((person) => !held.has(person.id))
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

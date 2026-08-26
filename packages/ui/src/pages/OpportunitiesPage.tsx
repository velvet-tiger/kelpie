import type { Opportunity, PipelineStage } from '@kelpie/schemas'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import {
  useCreateOpportunity,
  useOpportunities,
  useUpdateOpportunity,
} from '../api/resources/opportunities.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { MAX_PAGE_SIZE, usePlanItems } from '../api/resources/planItems.ts'
import { useTimezone } from '../api/resources/account.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column, DataTableGroup } from '../components/DataTable.tsx'
import { KanbanBoard } from '../components/KanbanBoard.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDate, formatDay } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'
import { serverSortOnly } from '../lib/sort.ts'

/**
 * The Opportunities pipeline: grants, accelerators, tenders, press, speaking.
 * The same board-and-list pair as Deals over the shared kanban, with kind in
 * place of value and a company that may be absent.
 */

type BoardView = 'list' | 'columns'
type PipelineScope = 'open' | 'all'
type ListGrouping = 'stage' | 'due'

const SCOPES: readonly PipelineScope[] = ['open', 'all']
const GROUPINGS: readonly ListGrouping[] = ['stage', 'due']

function readScope(stored: string | undefined): PipelineScope {
  return SCOPES.includes(stored as PipelineScope) ? (stored as PipelineScope) : 'open'
}

function readGrouping(stored: string | undefined): ListGrouping {
  return GROUPINGS.includes(stored as ListGrouping) ? (stored as ListGrouping) : 'stage'
}

const COLUMN_KEYS: readonly string[] = [
  'name',
  'kind',
  'company',
  'stage',
  'nextPlan',
  'owner',
  'close',
  'tags',
  'summary',
  'createdAt',
  'updatedAt',
]

/** Tones keyed by the seeded slugs. A renamed stage keeps its slug and its tone. */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  won: 'success',
  passed: 'danger',
  interview: 'warning',
  applied: 'accent',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = [
  'name',
  'kind',
  'company',
  'nextPlan',
  'owner',
  'close',
]

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function OpportunitiesPage(): React.JSX.Element {
  const navigate = useNavigate()

  const listView = useListView('opportunities', COLUMN_KEYS, DEFAULT_VISIBLE_KEYS)
  const view: BoardView = listView.mode ?? 'columns'
  const scope = readScope(listView.scope)
  const grouping = readGrouping(listView.grouping)
  const sort = listView.sort

  const stages = usePipelineStages('opportunity')
  const opportunities = useOpportunities({ sort: serverSortOnly(sort, SERVER_SORT_KEYS) })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createOpportunity = useCreateOpportunity()
  const updateOpportunity = useUpdateOpportunity()
  const timezone = useTimezone()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visibleOpportunities = opportunities.records.filter((opportunity) =>
    visibleStageIds.has(opportunity.stageId),
  )

  // The next-step column asks about the records on screen by id. `?target_id=`
  // takes at most one page of them (`api.md`), so past that ceiling the rest
  // read as having no plan; the note under the table says so.
  const askedIds = visibleOpportunities.slice(0, MAX_PAGE_SIZE).map((opportunity) => opportunity.id)
  const planItems = usePlanItems(
    {
      targetType: 'opportunity',
      targetIds: askedIds,
      statuses: ['todo', 'in_progress'],
      limit: MAX_PAGE_SIZE,
    },
    { enabled: askedIds.length > 0 },
  )
  const nextPlanByOpportunity = nextOpenByTarget(planItems.records)
  const plansTruncated = visibleOpportunities.length > MAX_PAGE_SIZE || planItems.hasNext

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addOpportunity(): Promise<void> {
    const opportunity = await createOpportunity.runAsync({ name: 'New opportunity' })

    await navigate(`/opportunities/${opportunity.id}`)
  }

  const stageLabelById = new Map(allStages.map((stage) => [stage.id, stage.label]))

  const columns: readonly Column<Opportunity>[] = [
    {
      key: 'name',
      header: 'Opportunity',
      sortKey: 'name',
      render: (opportunity) => <span className="font-medium text-ink">{opportunity.name}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      getSortValue: (opportunity) => opportunity.kind || null,
      render: (opportunity) => (opportunity.kind.length > 0 ? opportunity.kind : '—'),
    },
    {
      key: 'company',
      header: 'Company',
      getSortValue: (opportunity) =>
        opportunity.companyId === null ? null : (companyNameById.get(opportunity.companyId) ?? null),
      render: (opportunity) =>
        opportunity.companyId === null
          ? '—'
          : (companyNameById.get(opportunity.companyId) ?? '—'),
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (opportunity) => stageLabelById.get(opportunity.stageId) ?? null,
      render: (opportunity) => stageLabelById.get(opportunity.stageId) ?? '—',
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      getSortValue: (opportunity) => nextPlanByOpportunity.get(opportunity.id)?.date ?? null,
      render: (opportunity) => {
        const next = nextPlanByOpportunity.get(opportunity.id)

        if (next === undefined) {
          return '—'
        }

        return (
          <span className="text-ink-muted">
            {next.title}
            <span className="ml-1.5 font-mono text-[11px] text-ink-faint">
              {formatDay(next.date)}
            </span>
          </span>
        )
      },
    },
    {
      key: 'owner',
      header: 'Owner',
      getSortValue: (opportunity) =>
        opportunity.ownerId === null
          ? null
          : (members.nameById.get(opportunity.ownerId) ?? 'Unknown'),
      render: (opportunity) =>
        opportunity.ownerId === null
          ? '—'
          : (members.nameById.get(opportunity.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      getSortValue: (opportunity) => opportunity.expectedClose,
      render: (opportunity) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {opportunity.expectedClose === null ? '—' : formatDay(opportunity.expectedClose)}
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (opportunity) => opportunity.tags.join(', ') || null,
      render: (opportunity) =>
        opportunity.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {opportunity.tags.map((tag) => (
              <Chip key={tag}>
                <span className="text-[10px]">{tag}</span>
              </Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'summary',
      header: 'Summary',
      getSortValue: (opportunity) => opportunity.summary || null,
      render: (opportunity) =>
        opportunity.summary.length === 0 ? '—' : (
          <span className="text-ink-muted">{opportunity.summary}</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (opportunity) => formatDate(opportunity.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (opportunity) => formatDate(opportunity.updatedAt, timezone),
    },
  ]

  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  const stageGroups: readonly DataTableGroup<Opportunity>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visibleOpportunities.filter((opportunity) => opportunity.stageId === stage.id),
  }))

  /** Soonest first inside each bucket, so the top of "Overdue" is the oldest debt. */
  const dueGroups: readonly DataTableGroup<Opportunity>[] = DUE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    rows: visibleOpportunities
      .filter(
        (opportunity) =>
          dueBucketFor(nextPlanByOpportunity.get(opportunity.id)?.date) === bucket.id,
      )
      .sort((left, right) => {
        const leftNext = nextPlanByOpportunity.get(left.id)
        const rightNext = nextPlanByOpportunity.get(right.id)

        if (leftNext === undefined || rightNext === undefined) {
          return left.name.localeCompare(right.name)
        }

        return byDateThenTitle(leftNext, rightNext) || left.name.localeCompare(right.name)
      }),
  }))

  const cards = visibleOpportunities.map((opportunity) => {
    const next = nextPlanByOpportunity.get(opportunity.id)
    const companyName =
      opportunity.companyId === null ? undefined : companyNameById.get(opportunity.companyId)
    const meta = [
      opportunity.kind.length > 0 ? opportunity.kind : undefined,
      companyName,
      next?.title,
    ]
      .filter((part) => part !== undefined)
      .join(' · ')

    return {
      id: opportunity.id,
      stage: opportunity.stageId,
      title: opportunity.name,
      meta,
      href: `/opportunities/${opportunity.id}`,
    }
  })

  const isLoading = opportunities.isLoading || stages.isLoading
  const loadError = opportunities.error ?? stages.error

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Opportunities"
        onAdd={() => {
          void addOpportunity()
        }}
        addLabel="Add opportunity"
        actions={
          <>
            <Link
              to="/opportunities/settings"
              className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Settings
            </Link>
            <SegmentedControl
              ariaLabel="Stage scope"
              value={scope}
              onChange={(next) => {
                listView.setScope(next)
              }}
              options={[
                { id: 'open', label: 'Open' },
                { id: 'all', label: 'All' },
              ]}
            />
            {view === 'list' && (
              <SegmentedControl
                ariaLabel="Group the list"
                value={grouping}
                onChange={(next) => {
                  listView.setGrouping(next)
                }}
                options={[
                  { id: 'stage', label: 'By stage' },
                  { id: 'due', label: 'By due' },
                ]}
              />
            )}
            <SegmentedControl
              ariaLabel="Board or list"
              value={view}
              onChange={(next) => {
                listView.setMode(next)
              }}
              options={[
                { id: 'list', label: 'List' },
                { id: 'columns', label: 'Board' },
              ]}
            />
            {view === 'list' && (
              <ColumnPicker
                options={pickerOptions}
                visibleKeys={listView.visibleKeys}
                onChange={listView.setVisibleKeys}
              />
            )}
          </>
        }
      />

      {createOpportunity.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createOpportunity.error} />
        </div>
      )}

      {loadError !== null ? (
        <ErrorPanel error={loadError} />
      ) : isLoading ? (
        <LoadingPanel label="Loading opportunities…" />
      ) : (
        <>
          {view === 'columns' ? (
            <KanbanBoard
              stages={visibleStages.map((stage) => ({ id: stage.id, label: stage.label }))}
              cards={cards}
              onMove={(opportunityId, stageId) => {
                const opportunity = opportunities.records.find(
                  (candidate) => candidate.id === opportunityId,
                )

                if (opportunity !== undefined && opportunity.stageId !== stageId) {
                  updateOpportunity.run({ id: opportunityId, changes: { stageId } })
                }
              }}
            />
          ) : (
            <DataTable
              columns={columns}
              groups={grouping === 'stage' ? stageGroups : dueGroups}
              getRowId={(opportunity) => opportunity.id}
              onRowClick={(opportunity) => {
                void navigate(`/opportunities/${opportunity.id}`)
              }}
              emptyMessage={
                opportunities.records.length === 0
                  ? 'No opportunities yet'
                  : scope === 'open'
                    ? 'No open opportunities'
                    : 'No opportunities in this view'
              }
              emptyDescription={
                opportunities.records.length > 0 && scope === 'open'
                  ? 'You have opportunities, but none are open right now.'
                  : undefined
              }
              emptyAction={
                opportunities.records.length === 0
                  ? {
                      label: 'Add opportunity',
                      onClick: () => {
                        void addOpportunity()
                      },
                    }
                  : scope === 'open'
                    ? {
                        label: 'Show all opportunities',
                        onClick: () => {
                          listView.setScope('all')
                        },
                      }
                    : undefined
              }
              sort={sort}
              onSortChange={(next) => {
                listView.setSort(next)
              }}
              visibleColumnKeys={listView.visibleKeys}
            />
          )}
          {updateOpportunity.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateOpportunity.error} />
            </div>
          )}
          <Paginator list={opportunities} />
          {companies.hasNext && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More companies exist than one page returns, so some company names may show as “—”.
            </p>
          )}
          {plansTruncated && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More plan items exist than one page returns, so some opportunities may show no next
              plan.
            </p>
          )}
        </>
      )}
    </div>
  )
}

import type { Opportunity, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
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
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column, DataTableGroup } from '../components/DataTable.tsx'
import { KanbanBoard } from '../components/KanbanBoard.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDay } from '../lib/dates.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'

/**
 * The Opportunities pipeline: grants, accelerators, tenders, press, speaking.
 * The same board-and-list pair as Deals over the shared kanban, with kind in
 * place of value and a company that may be absent.
 */

type BoardView = 'list' | 'columns'
type PipelineScope = 'open' | 'all'
type ListGrouping = 'stage' | 'due'

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

export function OpportunitiesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [view, setView] = useState<BoardView>('list')
  const [scope, setScope] = useState<PipelineScope>('open')
  const [grouping, setGrouping] = useState<ListGrouping>('stage')
  const [sort, setSort] = useState<string | undefined>(undefined)

  const stages = usePipelineStages('opportunity')
  const opportunities = useOpportunities({ sort })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createOpportunity = useCreateOpportunity()
  const updateOpportunity = useUpdateOpportunity()

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
  const plansTruncated = visibleOpportunities.length > MAX_PAGE_SIZE || planItems.hasMore

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addOpportunity(): Promise<void> {
    const opportunity = await createOpportunity.runAsync({ name: 'New opportunity' })

    await navigate(`/opportunities/${opportunity.id}`)
  }

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
      render: (opportunity) => (opportunity.kind.length > 0 ? opportunity.kind : '—'),
    },
    {
      key: 'company',
      header: 'Company',
      render: (opportunity) =>
        opportunity.companyId === null
          ? '—'
          : (companyNameById.get(opportunity.companyId) ?? '—'),
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
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
      render: (opportunity) =>
        opportunity.ownerId === null
          ? '—'
          : (members.nameById.get(opportunity.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      render: (opportunity) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {opportunity.expectedClose === null ? '—' : formatDay(opportunity.expectedClose)}
        </span>
      ),
    },
  ]

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
              onChange={setScope}
              options={[
                { id: 'open', label: 'Open' },
                { id: 'all', label: 'All' },
              ]}
            />
            {view === 'list' && (
              <SegmentedControl
                ariaLabel="Group the list"
                value={grouping}
                onChange={setGrouping}
                options={[
                  { id: 'stage', label: 'By stage' },
                  { id: 'due', label: 'By due' },
                ]}
              />
            )}
            <SegmentedControl
              ariaLabel="Board or list"
              value={view}
              onChange={setView}
              options={[
                { id: 'list', label: 'List' },
                { id: 'columns', label: 'Board' },
              ]}
            />
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
                          setScope('all')
                        },
                      }
                    : undefined
              }
              sort={sort}
              onSortChange={setSort}
            />
          )}
          {updateOpportunity.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateOpportunity.error} />
            </div>
          )}
          {opportunities.hasMore && (
            <button
              type="button"
              onClick={opportunities.loadMore}
              disabled={opportunities.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {opportunities.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          {companies.hasMore && (
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

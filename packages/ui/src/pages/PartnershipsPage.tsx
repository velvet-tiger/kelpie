import type { Partnership, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import {
  useCreatePartnership,
  usePartnerships,
  useUpdatePartnership,
} from '../api/resources/partnerships.ts'
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
 * The Partnerships board: ongoing two-way relationships, grouped by status. The
 * same board-and-list pair as Deals over the shared kanban, with kind in place
 * of value and a next touchpoint in place of a close date.
 */

type BoardView = 'list' | 'columns'
type PipelineScope = 'open' | 'all'
type ListGrouping = 'stage' | 'due'

/** Tones keyed by the seeded slugs. A renamed stage keeps its slug and its tone. */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  active: 'success',
  exploring: 'accent',
  paused: 'warning',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

export function PartnershipsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [view, setView] = useState<BoardView>('list')
  const [scope, setScope] = useState<PipelineScope>('open')
  const [grouping, setGrouping] = useState<ListGrouping>('stage')
  const [sort, setSort] = useState<string | undefined>(undefined)

  const stages = usePipelineStages('partnership')
  const partnerships = usePartnerships({ sort })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createPartnership = useCreatePartnership()
  const updatePartnership = useUpdatePartnership()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visiblePartnerships = partnerships.records.filter((partnership) =>
    visibleStageIds.has(partnership.stageId),
  )

  // The next-step column asks about the records on screen by id. `?target_id=`
  // takes at most one page of them (`api.md`), so past that ceiling the rest
  // read as having no plan; the note under the table says so.
  const askedIds = visiblePartnerships.slice(0, MAX_PAGE_SIZE).map((partnership) => partnership.id)
  const planItems = usePlanItems(
    {
      targetType: 'partnership',
      targetIds: askedIds,
      statuses: ['todo', 'in_progress'],
      limit: MAX_PAGE_SIZE,
    },
    { enabled: askedIds.length > 0 },
  )
  const nextPlanByPartnership = nextOpenByTarget(planItems.records)
  const plansTruncated = visiblePartnerships.length > MAX_PAGE_SIZE || planItems.hasMore

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addPartnership(): Promise<void> {
    const firstCompany = companies.records[0]

    if (firstCompany === undefined) {
      return
    }

    const partnership = await createPartnership.runAsync({
      name: 'New partnership',
      companyId: firstCompany.id,
    })

    await navigate(`/partnerships/${partnership.id}`)
  }

  const columns: readonly Column<Partnership>[] = [
    {
      key: 'name',
      header: 'Partnership',
      sortKey: 'name',
      render: (partnership) => <span className="font-medium text-ink">{partnership.name}</span>,
    },
    {
      key: 'company',
      header: 'Company',
      render: (partnership) => companyNameById.get(partnership.companyId) ?? '—',
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (partnership) => (partnership.kind.length > 0 ? partnership.kind : '—'),
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      render: (partnership) => {
        const next = nextPlanByPartnership.get(partnership.id)

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
      render: (partnership) =>
        partnership.ownerId === null
          ? '—'
          : (members.nameById.get(partnership.ownerId) ?? 'Unknown'),
    },
    {
      key: 'next',
      header: 'Next touch',
      className: 'w-28',
      render: (partnership) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {partnership.nextTouchpoint === null ? '—' : formatDay(partnership.nextTouchpoint)}
        </span>
      ),
    },
  ]

  const stageGroups: readonly DataTableGroup<Partnership>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visiblePartnerships.filter((partnership) => partnership.stageId === stage.id),
  }))

  /** Soonest first inside each bucket, so the top of "Overdue" is the oldest debt. */
  const dueGroups: readonly DataTableGroup<Partnership>[] = DUE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    rows: visiblePartnerships
      .filter(
        (partnership) =>
          dueBucketFor(nextPlanByPartnership.get(partnership.id)?.date) === bucket.id,
      )
      .sort((left, right) => {
        const leftNext = nextPlanByPartnership.get(left.id)
        const rightNext = nextPlanByPartnership.get(right.id)

        if (leftNext === undefined || rightNext === undefined) {
          return left.name.localeCompare(right.name)
        }

        return byDateThenTitle(leftNext, rightNext) || left.name.localeCompare(right.name)
      }),
  }))

  const cards = visiblePartnerships.map((partnership) => {
    const next = nextPlanByPartnership.get(partnership.id)
    const companyName = companyNameById.get(partnership.companyId)
    const meta = [companyName, next?.title].filter((part) => part !== undefined).join(' · ')

    return {
      id: partnership.id,
      stage: partnership.stageId,
      title: partnership.name,
      meta,
      href: `/partnerships/${partnership.id}`,
    }
  })

  const isLoading = partnerships.isLoading || stages.isLoading
  const loadError = partnerships.error ?? stages.error

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Partnerships"
        onAdd={() => {
          void addPartnership()
        }}
        addLabel="Add partnership"
        actions={
          <>
            <Link
              to="/partnerships/settings"
              className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
            >
              Settings
            </Link>
            <SegmentedControl
              ariaLabel="Status scope"
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
                  { id: 'stage', label: 'By status' },
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

      {companies.records.length === 0 && !companies.isLoading && (
        <p className="mb-3 text-[12px] text-ink-faint">
          A partnership belongs to a company, so add a company before adding a partnership.
        </p>
      )}

      {createPartnership.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createPartnership.error} />
        </div>
      )}

      {loadError !== null ? (
        <ErrorPanel error={loadError} />
      ) : isLoading ? (
        <LoadingPanel label="Loading partnerships…" />
      ) : (
        <>
          {view === 'columns' ? (
            <KanbanBoard
              stages={visibleStages.map((stage) => ({ id: stage.id, label: stage.label }))}
              cards={cards}
              onMove={(partnershipId, stageId) => {
                const partnership = partnerships.records.find(
                  (candidate) => candidate.id === partnershipId,
                )

                if (partnership !== undefined && partnership.stageId !== stageId) {
                  updatePartnership.run({ id: partnershipId, changes: { stageId } })
                }
              }}
            />
          ) : (
            <DataTable
              columns={columns}
              groups={grouping === 'stage' ? stageGroups : dueGroups}
              getRowId={(partnership) => partnership.id}
              onRowClick={(partnership) => {
                void navigate(`/partnerships/${partnership.id}`)
              }}
              emptyMessage={
                partnerships.records.length === 0
                  ? 'No partnerships yet'
                  : scope === 'open'
                    ? 'No open partnerships'
                    : 'No partnerships in this view'
              }
              emptyDescription={
                partnerships.records.length > 0 && scope === 'open'
                  ? 'You have partnerships, but none are open right now.'
                  : undefined
              }
              emptyAction={
                partnerships.records.length === 0
                  ? {
                      label: 'Add partnership',
                      onClick: () => {
                        void addPartnership()
                      },
                    }
                  : scope === 'open'
                    ? {
                        label: 'Show all partnerships',
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
          {updatePartnership.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updatePartnership.error} />
            </div>
          )}
          {partnerships.hasMore && (
            <button
              type="button"
              onClick={partnerships.loadMore}
              disabled={partnerships.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {partnerships.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          {companies.hasMore && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More companies exist than one page returns, so some company names may show as “—”.
            </p>
          )}
          {plansTruncated && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More plan items exist than one page returns, so some partnerships may show no next
              plan.
            </p>
          )}
        </>
      )}
    </div>
  )
}

import type { Partnership, PipelineStage } from '@kelpie/schemas'
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
 * The Partnerships board: ongoing two-way relationships, grouped by status. The
 * same board-and-list pair as Deals over the shared kanban, with kind in place
 * of value and a next touchpoint in place of a close date.
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
  'company',
  'stage',
  'kind',
  'nextPlan',
  'owner',
  'next',
  'goals',
  'successLooksLike',
  'tags',
  'summary',
  'createdAt',
  'updatedAt',
]

/** Tones keyed by the seeded slugs. A renamed stage keeps its slug and its tone. */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  active: 'success',
  exploring: 'accent',
  paused: 'warning',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = [
  'name',
  'company',
  'kind',
  'nextPlan',
  'owner',
  'next',
]

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function PartnershipsPage(): React.JSX.Element {
  const navigate = useNavigate()

  const listView = useListView('partnerships', COLUMN_KEYS, DEFAULT_VISIBLE_KEYS)
  const view: BoardView = listView.mode ?? 'columns'
  const scope = readScope(listView.scope)
  const grouping = readGrouping(listView.grouping)
  const sort = listView.sort

  const stages = usePipelineStages('partnership')
  const partnerships = usePartnerships({ sort: serverSortOnly(sort, SERVER_SORT_KEYS) })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createPartnership = useCreatePartnership()
  const updatePartnership = useUpdatePartnership()
  const timezone = useTimezone()

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
  const plansTruncated = visiblePartnerships.length > MAX_PAGE_SIZE || planItems.hasNext

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

  const stageLabelById = new Map(allStages.map((stage) => [stage.id, stage.label]))

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
      getSortValue: (partnership) => companyNameById.get(partnership.companyId) ?? null,
      render: (partnership) => companyNameById.get(partnership.companyId) ?? '—',
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (partnership) => stageLabelById.get(partnership.stageId) ?? null,
      render: (partnership) => stageLabelById.get(partnership.stageId) ?? '—',
    },
    {
      key: 'kind',
      header: 'Kind',
      getSortValue: (partnership) => partnership.kind || null,
      render: (partnership) => (partnership.kind.length > 0 ? partnership.kind : '—'),
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      getSortValue: (partnership) => nextPlanByPartnership.get(partnership.id)?.date ?? null,
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
      getSortValue: (partnership) =>
        partnership.ownerId === null
          ? null
          : (members.nameById.get(partnership.ownerId) ?? 'Unknown'),
      render: (partnership) =>
        partnership.ownerId === null
          ? '—'
          : (members.nameById.get(partnership.ownerId) ?? 'Unknown'),
    },
    {
      key: 'next',
      header: 'Next touch',
      className: 'w-28',
      getSortValue: (partnership) => partnership.nextTouchpoint,
      render: (partnership) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {partnership.nextTouchpoint === null ? '—' : formatDay(partnership.nextTouchpoint)}
        </span>
      ),
    },
    {
      key: 'goals',
      header: 'Goals',
      getSortValue: (partnership) => partnership.goals || null,
      render: (partnership) =>
        partnership.goals.length === 0 ? '—' : (
          <span className="text-ink-muted">{partnership.goals}</span>
        ),
    },
    {
      key: 'successLooksLike',
      header: 'Success looks like',
      getSortValue: (partnership) => partnership.successLooksLike || null,
      render: (partnership) =>
        partnership.successLooksLike.length === 0 ? '—' : (
          <span className="text-ink-muted">{partnership.successLooksLike}</span>
        ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (partnership) => partnership.tags.join(', ') || null,
      render: (partnership) =>
        partnership.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {partnership.tags.map((tag) => (
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
      getSortValue: (partnership) => partnership.summary || null,
      render: (partnership) =>
        partnership.summary.length === 0 ? '—' : (
          <span className="text-ink-muted">{partnership.summary}</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (partnership) => formatDate(partnership.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (partnership) => formatDate(partnership.updatedAt, timezone),
    },
  ]

  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

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
                  { id: 'stage', label: 'By status' },
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
          {updatePartnership.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updatePartnership.error} />
            </div>
          )}
          <Paginator list={partnerships} />
          {companies.hasNext && (
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

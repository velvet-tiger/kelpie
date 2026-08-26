import type { PipelineStage, Raise } from '@kelpie/schemas'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { MAX_PAGE_SIZE, usePlanItems } from '../api/resources/planItems.ts'
import { useCreateRaise, useRaises, useUpdateRaise } from '../api/resources/raises.ts'
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
import { formatMoney } from '../lib/money.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'
import { serverSortOnly } from '../lib/sort.ts'

/**
 * The Fundraising board: one raise per firm per round, grouped by stage. The
 * same board-and-list pair as Deals over the shared kanban, with the check size
 * in place of the deal value and the firm in place of the company.
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
  'check',
  'currency',
  'thesisFit',
  'passReason',
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
  closed: 'success',
  passed: 'danger',
  term_sheet: 'warning',
  diligence: 'warning',
  meeting: 'accent',
  intro: 'accent',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = [
  'name',
  'company',
  'check',
  'nextPlan',
  'owner',
  'close',
]

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function FundraisingPage(): React.JSX.Element {
  const navigate = useNavigate()

  const listView = useListView('raises', COLUMN_KEYS, DEFAULT_VISIBLE_KEYS)
  const view: BoardView = listView.mode ?? 'columns'
  const scope = readScope(listView.scope)
  const grouping = readGrouping(listView.grouping)
  const sort = listView.sort

  const stages = usePipelineStages('raise')
  const raises = useRaises({ sort: serverSortOnly(sort, SERVER_SORT_KEYS) })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createRaise = useCreateRaise()
  const updateRaise = useUpdateRaise()
  const timezone = useTimezone()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visibleRaises = raises.records.filter((raise) => visibleStageIds.has(raise.stageId))

  // The next-step column asks about the records on screen by id. `?target_id=`
  // takes at most one page of them (`api.md`), so past that ceiling the rest
  // read as having no plan; the note under the table says so.
  const askedIds = visibleRaises.slice(0, MAX_PAGE_SIZE).map((raise) => raise.id)
  const planItems = usePlanItems(
    {
      targetType: 'raise',
      targetIds: askedIds,
      statuses: ['todo', 'in_progress'],
      limit: MAX_PAGE_SIZE,
    },
    { enabled: askedIds.length > 0 },
  )
  const nextPlanByRaise = nextOpenByTarget(planItems.records)
  const plansTruncated = visibleRaises.length > MAX_PAGE_SIZE || planItems.hasNext

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addRaise(): Promise<void> {
    const firstCompany = companies.records[0]

    if (firstCompany === undefined) {
      return
    }

    const raise = await createRaise.runAsync({
      name: 'New raise',
      companyId: firstCompany.id,
    })

    await navigate(`/fundraising/${raise.id}`)
  }

  const stageLabelById = new Map(allStages.map((stage) => [stage.id, stage.label]))

  const columns: readonly Column<Raise>[] = [
    {
      key: 'name',
      header: 'Raise',
      sortKey: 'name',
      render: (raise) => <span className="font-medium text-ink">{raise.name}</span>,
    },
    {
      key: 'company',
      header: 'Firm',
      getSortValue: (raise) => companyNameById.get(raise.companyId) ?? null,
      render: (raise) => companyNameById.get(raise.companyId) ?? '—',
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (raise) => stageLabelById.get(raise.stageId) ?? null,
      render: (raise) => stageLabelById.get(raise.stageId) ?? '—',
    },
    {
      key: 'check',
      header: 'Check',
      className: 'w-28',
      getSortValue: (raise) => raise.checkSizeCents,
      render: (raise) =>
        raise.checkSizeCents === null ? (
          '—'
        ) : (
          <span className="font-mono text-[12px]">
            {formatMoney(raise.checkSizeCents, raise.currency)}
          </span>
        ),
    },
    {
      key: 'currency',
      header: 'Currency',
      getSortValue: (raise) => raise.currency,
      render: (raise) => raise.currency ?? '—',
    },
    {
      key: 'thesisFit',
      header: 'Thesis fit',
      getSortValue: (raise) => raise.thesisFit || null,
      render: (raise) =>
        raise.thesisFit.length === 0 ? '—' : (
          <span className="text-ink-muted">{raise.thesisFit}</span>
        ),
    },
    {
      key: 'passReason',
      header: 'Pass reason',
      getSortValue: (raise) => raise.passReason,
      render: (raise) =>
        raise.passReason === null ? '—' : (
          <span className="text-ink-muted">{raise.passReason}</span>
        ),
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      getSortValue: (raise) => nextPlanByRaise.get(raise.id)?.date ?? null,
      render: (raise) => {
        const next = nextPlanByRaise.get(raise.id)

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
      getSortValue: (raise) =>
        raise.ownerId === null ? null : (members.nameById.get(raise.ownerId) ?? 'Unknown'),
      render: (raise) =>
        raise.ownerId === null ? '—' : (members.nameById.get(raise.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      getSortValue: (raise) => raise.expectedClose,
      render: (raise) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {raise.expectedClose === null ? '—' : formatDay(raise.expectedClose)}
        </span>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (raise) => raise.tags.join(', ') || null,
      render: (raise) =>
        raise.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {raise.tags.map((tag) => (
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
      getSortValue: (raise) => raise.summary || null,
      render: (raise) =>
        raise.summary.length === 0 ? '—' : <span className="text-ink-muted">{raise.summary}</span>,
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (raise) => formatDate(raise.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (raise) => formatDate(raise.updatedAt, timezone),
    },
  ]

  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  const stageGroups: readonly DataTableGroup<Raise>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visibleRaises.filter((raise) => raise.stageId === stage.id),
  }))

  /** Soonest first inside each bucket, so the top of "Overdue" is the oldest debt. */
  const dueGroups: readonly DataTableGroup<Raise>[] = DUE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    rows: visibleRaises
      .filter((raise) => dueBucketFor(nextPlanByRaise.get(raise.id)?.date) === bucket.id)
      .sort((left, right) => {
        const leftNext = nextPlanByRaise.get(left.id)
        const rightNext = nextPlanByRaise.get(right.id)

        if (leftNext === undefined || rightNext === undefined) {
          return left.name.localeCompare(right.name)
        }

        return byDateThenTitle(leftNext, rightNext) || left.name.localeCompare(right.name)
      }),
  }))

  const cards = visibleRaises.map((raise) => {
    const next = nextPlanByRaise.get(raise.id)
    const company = companyNameById.get(raise.companyId) ?? '—'

    return {
      id: raise.id,
      stage: raise.stageId,
      title: raise.name,
      meta: next === undefined ? company : `${company} · ${next.title}`,
      valueLabel:
        raise.checkSizeCents === null
          ? undefined
          : formatMoney(raise.checkSizeCents, raise.currency),
      href: `/fundraising/${raise.id}`,
    }
  })

  const isLoading = raises.isLoading || stages.isLoading
  const loadError = raises.error ?? stages.error

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Fundraising"
        onAdd={() => {
          void addRaise()
        }}
        addLabel="Add raise"
        actions={
          <>
            <Link
              to="/fundraising/settings"
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

      {companies.records.length === 0 && !companies.isLoading && (
        <p className="mb-3 text-[12px] text-ink-faint">
          A raise belongs to a firm, so add a company before adding a raise.
        </p>
      )}

      {createRaise.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createRaise.error} />
        </div>
      )}

      {loadError !== null ? (
        <ErrorPanel error={loadError} />
      ) : isLoading ? (
        <LoadingPanel label="Loading raises…" />
      ) : (
        <>
          {view === 'columns' ? (
            <KanbanBoard
              stages={visibleStages.map((stage) => ({ id: stage.id, label: stage.label }))}
              cards={cards}
              onMove={(raiseId, stageId) => {
                const raise = raises.records.find((candidate) => candidate.id === raiseId)

                if (raise !== undefined && raise.stageId !== stageId) {
                  updateRaise.run({ id: raiseId, changes: { stageId } })
                }
              }}
            />
          ) : (
            <DataTable
              columns={columns}
              groups={grouping === 'stage' ? stageGroups : dueGroups}
              getRowId={(raise) => raise.id}
              onRowClick={(raise) => {
                void navigate(`/fundraising/${raise.id}`)
              }}
              emptyMessage={
                raises.records.length === 0
                  ? 'No raises yet'
                  : scope === 'open'
                    ? 'No open raises'
                    : 'No raises in this view'
              }
              emptyDescription={
                raises.records.length > 0 && scope === 'open'
                  ? 'You have raises, but none are open right now.'
                  : undefined
              }
              emptyAction={
                raises.records.length === 0
                  ? {
                      label: 'Add raise',
                      onClick: () => {
                        void addRaise()
                      },
                    }
                  : scope === 'open'
                    ? {
                        label: 'Show all raises',
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
          {updateRaise.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateRaise.error} />
            </div>
          )}
          <Paginator list={raises} />
          {companies.hasNext && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More companies exist than one page returns, so some firm names may show as “—”.
            </p>
          )}
          {plansTruncated && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More plan items exist than one page returns, so some raises may show no next plan.
            </p>
          )}
        </>
      )}
    </div>
  )
}

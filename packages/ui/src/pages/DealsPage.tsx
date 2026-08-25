import type { Deal, PipelineStage } from '@kelpie/schemas'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useDeals, useCreateDeal, useUpdateDeal } from '../api/resources/deals.ts'
import { useMembers } from '../api/resources/members.ts'
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
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDate, formatDay } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { formatMoney } from '../lib/money.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'
import { serverSortOnly } from '../lib/sort.ts'

/**
 * The Deals pipeline: a board and a list over the same records, grouped by stage
 * or by when the next step falls due.
 *
 * A drag on the board is a PATCH of `stage_id`; the optimistic cache write moves
 * the card at once and the server's answer settles it.
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

/** Tones keyed by the seeded slugs. A renamed stage keeps its slug and its tone. */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  won: 'success',
  lost: 'danger',
  negotiation: 'warning',
  proposal: 'accent',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = [
  'name',
  'company',
  'value',
  'nextPlan',
  'owner',
  'close',
]

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function DealsPage(): React.JSX.Element {
  const navigate = useNavigate()

  const stages = usePipelineStages('deal')
  const companies = useCompanies({ limit: 200 })
  // The list-view controller holds every persisted knob, so it is declared
  // before the deals query — the sort it stores decides which page comes
  // back. Board vs list defaults to the board here; the other three read
  // their own default from the readers above.
  const supportedKeys: readonly string[] = [
    'name',
    'company',
    'stage',
    'value',
    'currency',
    'nextPlan',
    'owner',
    'close',
    'competitors',
    'tags',
    'summary',
    'risks',
    'whyWin',
    'externalId',
    'createdAt',
    'updatedAt',
  ]
  const listView = useListView('deals', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const view: BoardView = listView.mode ?? 'columns'
  const scope = readScope(listView.scope)
  const grouping = readGrouping(listView.grouping)
  const sort = listView.sort
  const deals = useDeals({ sort: serverSortOnly(sort, SERVER_SORT_KEYS) })
  const members = useMembers()
  const createDeal = useCreateDeal()
  const updateDeal = useUpdateDeal()
  const timezone = useTimezone()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visibleDeals = deals.records.filter((deal) => visibleStageIds.has(deal.stageId))

  // The next-step column asks about the deals on screen by id. `?target_id=`
  // takes at most one page of them (`api.md`), so past that ceiling the rest
  // read as having no plan; the note under the table says so.
  const askedDealIds = visibleDeals.slice(0, MAX_PAGE_SIZE).map((deal) => deal.id)
  const planItems = usePlanItems(
    { targetType: 'deal', targetIds: askedDealIds, statuses: ['todo', 'in_progress'], limit: MAX_PAGE_SIZE },
    { enabled: askedDealIds.length > 0 },
  )
  const nextPlanByDeal = nextOpenByTarget(planItems.records)
  const plansTruncated = visibleDeals.length > MAX_PAGE_SIZE || planItems.hasMore

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addDeal(): Promise<void> {
    const firstCompany = companies.records[0]

    if (firstCompany === undefined) {
      return
    }

    const deal = await createDeal.runAsync({ name: 'New deal', companyId: firstCompany.id })

    await navigate(`/deals/${deal.id}`)
  }

  const stageLabelById = new Map(allStages.map((stage) => [stage.id, stage.label]))

  const columns: readonly Column<Deal>[] = [
    {
      key: 'name',
      header: 'Deal',
      sortKey: 'name',
      render: (deal) => <span className="font-medium text-ink">{deal.name}</span>,
    },
    {
      key: 'company',
      header: 'Company',
      getSortValue: (deal) => companyNameById.get(deal.companyId) ?? null,
      render: (deal) => companyNameById.get(deal.companyId) ?? '—',
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (deal) => stageLabelById.get(deal.stageId) ?? null,
      render: (deal) => stageLabelById.get(deal.stageId) ?? '—',
    },
    {
      key: 'value',
      header: 'Value',
      className: 'w-28',
      getSortValue: (deal) => deal.valueCents,
      render: (deal) => (
        <span className="font-mono text-[12px]">
          {deal.valueCents === null ? '—' : formatMoney(deal.valueCents, deal.currency)}
        </span>
      ),
    },
    {
      key: 'currency',
      header: 'Currency',
      getSortValue: (deal) => deal.currency,
      render: (deal) => deal.currency ?? '—',
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      getSortValue: (deal) => nextPlanByDeal.get(deal.id)?.date ?? null,
      render: (deal) => {
        const next = nextPlanByDeal.get(deal.id)

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
      getSortValue: (deal) =>
        deal.ownerId === null ? null : (members.nameById.get(deal.ownerId) ?? 'Unknown'),
      render: (deal) =>
        deal.ownerId === null ? '—' : (members.nameById.get(deal.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      getSortValue: (deal) => deal.expectedClose,
      render: (deal) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {deal.expectedClose === null ? '—' : formatDay(deal.expectedClose)}
        </span>
      ),
    },
    {
      key: 'competitors',
      header: 'Competitors',
      getSortValue: (deal) => deal.competitors.join(', ') || null,
      render: (deal) =>
        deal.competitors.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {deal.competitors.map((entry) => (
              <Chip key={entry}>
                <span className="text-[10px]">{entry}</span>
              </Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (deal) => deal.tags.join(', ') || null,
      render: (deal) =>
        deal.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {deal.tags.map((tag) => (
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
      getSortValue: (deal) => deal.summary || null,
      render: (deal) =>
        deal.summary.length === 0 ? '—' : <span className="text-ink-muted">{deal.summary}</span>,
    },
    {
      key: 'risks',
      header: 'Risks',
      getSortValue: (deal) => deal.risks || null,
      render: (deal) =>
        deal.risks.length === 0 ? '—' : <span className="text-ink-muted">{deal.risks}</span>,
    },
    {
      key: 'whyWin',
      header: 'Why win',
      getSortValue: (deal) => deal.whyWin || null,
      render: (deal) =>
        deal.whyWin.length === 0 ? '—' : <span className="text-ink-muted">{deal.whyWin}</span>,
    },
    {
      key: 'externalId',
      header: 'External ID',
      getSortValue: (deal) => deal.externalId,
      render: (deal) =>
        deal.externalId === null ? (
          '—'
        ) : (
          <span className="font-mono text-[12px] text-ink-muted">{deal.externalId}</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (deal) => formatDate(deal.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (deal) => formatDate(deal.updatedAt, timezone),
    },
  ]

  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  const stageGroups: readonly DataTableGroup<Deal>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visibleDeals.filter((deal) => deal.stageId === stage.id),
  }))

  /** Soonest first inside each bucket, so the top of "Overdue" is the oldest debt. */
  const dueGroups: readonly DataTableGroup<Deal>[] = DUE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    rows: visibleDeals
      .filter((deal) => dueBucketFor(nextPlanByDeal.get(deal.id)?.date) === bucket.id)
      .sort((left, right) => {
        const leftNext = nextPlanByDeal.get(left.id)
        const rightNext = nextPlanByDeal.get(right.id)

        if (leftNext === undefined || rightNext === undefined) {
          return left.name.localeCompare(right.name)
        }

        return byDateThenTitle(leftNext, rightNext) || left.name.localeCompare(right.name)
      }),
  }))

  const cards = visibleDeals.map((deal) => {
    const next = nextPlanByDeal.get(deal.id)
    const company = companyNameById.get(deal.companyId) ?? '—'

    return {
      id: deal.id,
      stage: deal.stageId,
      title: deal.name,
      meta: next === undefined ? company : `${company} · ${next.title}`,
      valueLabel:
        deal.valueCents === null ? undefined : formatMoney(deal.valueCents, deal.currency),
      href: `/deals/${deal.id}`,
    }
  })

  const isLoading = deals.isLoading || stages.isLoading
  const loadError = deals.error ?? stages.error

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Deals"
        onAdd={() => {
          void addDeal()
        }}
        addLabel="Add deal"
        actions={
          <>
            <Link
              to="/deals/settings"
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

      {createDeal.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createDeal.error} />
        </div>
      )}
      {companies.records.length === 0 && !companies.isLoading && (
        <p className="mb-3 text-[12px] text-ink-faint">
          A deal belongs to a company, so add a company before adding a deal.
        </p>
      )}

      {loadError !== null ? (
        <ErrorPanel error={loadError} />
      ) : isLoading ? (
        <LoadingPanel label="Loading deals…" />
      ) : (
        <>
          {view === 'columns' ? (
            <KanbanBoard
              stages={visibleStages.map((stage) => ({ id: stage.id, label: stage.label }))}
              cards={cards}
              onMove={(dealId, stageId) => {
                const deal = deals.records.find((candidate) => candidate.id === dealId)

                if (deal !== undefined && deal.stageId !== stageId) {
                  updateDeal.run({ id: dealId, changes: { stageId } })
                }
              }}
            />
          ) : (
            <DataTable
              columns={columns}
              groups={grouping === 'stage' ? stageGroups : dueGroups}
              getRowId={(deal) => deal.id}
              onRowClick={(deal) => {
                void navigate(`/deals/${deal.id}`)
              }}
              emptyMessage={
                deals.records.length === 0
                  ? 'No deals yet'
                  : scope === 'open'
                    ? 'No open deals'
                    : 'No deals in this view'
              }
              emptyDescription={
                deals.records.length === 0
                  ? undefined
                  : scope === 'open'
                    ? 'You have deals, but none are open right now.'
                    : undefined
              }
              emptyAction={
                deals.records.length === 0
                  ? {
                      label: 'Add deal',
                      onClick: () => {
                        void addDeal()
                      },
                    }
                  : scope === 'open'
                    ? {
                        label: 'Show all deals',
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
          {updateDeal.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateDeal.error} />
            </div>
          )}
          {deals.hasMore && (
            <button
              type="button"
              onClick={deals.loadMore}
              disabled={deals.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {deals.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          {companies.hasMore && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More companies exist than one page returns, so some company names may show as “—”.
            </p>
          )}
          {plansTruncated && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More plan items exist than one page returns, so some deals may show no next plan.
            </p>
          )}
        </>
      )}
    </div>
  )
}

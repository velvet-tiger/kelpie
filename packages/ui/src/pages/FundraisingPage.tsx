import type { PipelineStage, Raise } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useMembers } from '../api/resources/members.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
import { MAX_PAGE_SIZE, usePlanItems } from '../api/resources/planItems.ts'
import { useCreateRaise, useRaises, useUpdateRaise } from '../api/resources/raises.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column, DataTableGroup } from '../components/DataTable.tsx'
import { KanbanBoard } from '../components/KanbanBoard.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDay } from '../lib/dates.ts'
import { formatMoney } from '../lib/money.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'

/**
 * The Fundraising board: one raise per firm per round, grouped by stage. The
 * same board-and-list pair as Deals over the shared kanban, with the check size
 * in place of the deal value and the firm in place of the company.
 */

type BoardView = 'list' | 'columns'
type PipelineScope = 'open' | 'all'
type ListGrouping = 'stage' | 'due'

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

export function FundraisingPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [view, setView] = useState<BoardView>('list')
  const [scope, setScope] = useState<PipelineScope>('open')
  const [grouping, setGrouping] = useState<ListGrouping>('stage')

  const stages = usePipelineStages('raise')
  const raises = useRaises()
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createRaise = useCreateRaise()
  const updateRaise = useUpdateRaise()

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
  const plansTruncated = visibleRaises.length > MAX_PAGE_SIZE || planItems.hasMore

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

  const columns: readonly Column<Raise>[] = [
    {
      key: 'name',
      header: 'Raise',
      render: (raise) => <span className="font-medium text-ink">{raise.name}</span>,
    },
    {
      key: 'company',
      header: 'Firm',
      render: (raise) => companyNameById.get(raise.companyId) ?? '—',
    },
    {
      key: 'check',
      header: 'Check',
      className: 'w-28',
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
      key: 'nextPlan',
      header: 'Next plan',
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
      render: (raise) =>
        raise.ownerId === null ? '—' : (members.nameById.get(raise.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      render: (raise) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {raise.expectedClose === null ? '—' : formatDay(raise.expectedClose)}
        </span>
      ),
    },
  ]

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
              emptyMessage="No raises yet"
            />
          )}
          {updateRaise.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateRaise.error} />
            </div>
          )}
          {raises.hasMore && (
            <button
              type="button"
              onClick={raises.loadMore}
              disabled={raises.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {raises.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
          {companies.hasMore && (
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

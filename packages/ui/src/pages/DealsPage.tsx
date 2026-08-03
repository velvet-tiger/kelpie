import type { Deal, PipelineStage } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useDeals, useCreateDeal, useUpdateDeal } from '../api/resources/deals.ts'
import { useMembers } from '../api/resources/members.ts'
import { usePipelineStages } from '../api/resources/pipelineStages.ts'
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

/**
 * The Deals pipeline: a board and a stage-grouped list over the same records.
 *
 * A drag on the board is a PATCH of `stage_id`; the optimistic cache write moves
 * the card at once and the server's answer settles it. The mockup's "next plan"
 * column and due-bucket grouping wait on the Plan items API.
 */

type BoardView = 'list' | 'columns'
type PipelineScope = 'open' | 'all'

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

export function DealsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [view, setView] = useState<BoardView>('list')
  const [scope, setScope] = useState<PipelineScope>('open')

  const stages = usePipelineStages('deal')
  const deals = useDeals()
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createDeal = useCreateDeal()
  const updateDeal = useUpdateDeal()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visibleDeals = deals.records.filter((deal) => visibleStageIds.has(deal.stageId))

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addDeal(): Promise<void> {
    const firstCompany = companies.records[0]

    if (firstCompany === undefined) {
      return
    }

    const deal = await createDeal.runAsync({ name: 'New deal', companyId: firstCompany.id })

    await navigate(`/deals/${deal.id}`)
  }

  const columns: readonly Column<Deal>[] = [
    {
      key: 'name',
      header: 'Deal',
      render: (deal) => <span className="font-medium text-ink">{deal.name}</span>,
    },
    {
      key: 'company',
      header: 'Company',
      render: (deal) => companyNameById.get(deal.companyId) ?? '—',
    },
    {
      key: 'value',
      header: 'Value',
      className: 'w-28',
      render: (deal) => (
        <span className="font-mono text-[12px]">
          {deal.valueCents === null ? '—' : formatMoney(deal.valueCents, deal.currency)}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (deal) =>
        deal.ownerId === null ? '—' : (members.nameById.get(deal.ownerId) ?? 'Unknown'),
    },
    {
      key: 'close',
      header: 'Close',
      className: 'w-28',
      render: (deal) => (
        <span className="font-mono text-[12px] text-ink-muted">
          {deal.expectedClose === null ? '—' : formatDay(deal.expectedClose)}
        </span>
      ),
    },
  ]

  const groups: readonly DataTableGroup<Deal>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visibleDeals.filter((deal) => deal.stageId === stage.id),
  }))

  const cards = visibleDeals.map((deal) => ({
    id: deal.id,
    stage: deal.stageId,
    title: deal.name,
    meta: companyNameById.get(deal.companyId) ?? '—',
    valueLabel:
      deal.valueCents === null ? undefined : formatMoney(deal.valueCents, deal.currency),
    href: `/deals/${deal.id}`,
  }))

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
              onChange={setScope}
              options={[
                { id: 'open', label: 'Open' },
                { id: 'all', label: 'All' },
              ]}
            />
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
              groups={groups}
              getRowId={(deal) => deal.id}
              onRowClick={(deal) => {
                void navigate(`/deals/${deal.id}`)
              }}
              emptyMessage="No deals yet"
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
        </>
      )}
    </div>
  )
}

import type { Enquiry, PipelineStage } from '@kelpie/schemas'
import { Link, useNavigate } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import {
  useCreateEnquiry,
  useEnquiries,
  useUpdateEnquiry,
} from '../api/resources/enquiries.ts'
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
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDate, formatDay } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { DUE_BUCKETS, byDateThenTitle, dueBucketFor, nextOpenByTarget } from '../lib/plan.ts'
import { serverSortOnly } from '../lib/sort.ts'

/**
 * The Enquiries pipeline: inbound requests that may become a Deal. The same
 * board-and-list pair as Opportunities over the shared kanban, with `source`
 * in place of `kind` and a company that may be absent.
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
  'source',
  'company',
  'stage',
  'nextPlan',
  'owner',
  'tags',
  'summary',
  'createdAt',
  'updatedAt',
]

/** Tones keyed by the seeded slugs. A renamed stage keeps its slug and its tone. */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  new: 'accent',
  in_progress: 'warning',
  closed: 'neutral',
}

function stageTone(stage: PipelineStage): ChipTone {
  return STAGE_TONES[stage.slug] ?? 'neutral'
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = [
  'name',
  'source',
  'company',
  'nextPlan',
  'owner',
]

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function EnquiriesPage(): React.JSX.Element {
  const navigate = useNavigate()

  const listView = useListView('enquiries', COLUMN_KEYS, DEFAULT_VISIBLE_KEYS)
  const view: BoardView = listView.mode ?? 'columns'
  const scope = readScope(listView.scope)
  const grouping = readGrouping(listView.grouping)
  const sort = listView.sort

  const stages = usePipelineStages('enquiry')
  const enquiries = useEnquiries({ sort: serverSortOnly(sort, SERVER_SORT_KEYS) })
  const companies = useCompanies({ limit: 200 })
  const members = useMembers()
  const createEnquiry = useCreateEnquiry()
  const updateEnquiry = useUpdateEnquiry()
  const timezone = useTimezone()

  const allStages = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const visibleStages = scope === 'open' ? allStages.filter((stage) => stage.open) : allStages
  const visibleStageIds = new Set(visibleStages.map((stage) => stage.id))
  const visibleEnquiries = enquiries.records.filter((enquiry) =>
    visibleStageIds.has(enquiry.stageId),
  )

  const askedIds = visibleEnquiries.slice(0, MAX_PAGE_SIZE).map((enquiry) => enquiry.id)
  const planItems = usePlanItems(
    {
      targetType: 'enquiry',
      targetIds: askedIds,
      statuses: ['todo', 'in_progress'],
      limit: MAX_PAGE_SIZE,
    },
    { enabled: askedIds.length > 0 },
  )
  const nextPlanByEnquiry = nextOpenByTarget(planItems.records)
  const plansTruncated = visibleEnquiries.length > MAX_PAGE_SIZE || planItems.hasNext

  const companyNameById = new Map(companies.records.map((company) => [company.id, company.name]))

  async function addEnquiry(): Promise<void> {
    const enquiry = await createEnquiry.runAsync({ name: 'New enquiry' })

    await navigate(`/enquiries/${enquiry.id}`)
  }

  const stageLabelById = new Map(allStages.map((stage) => [stage.id, stage.label]))

  const columns: readonly Column<Enquiry>[] = [
    {
      key: 'name',
      header: 'Enquiry',
      sortKey: 'name',
      render: (enquiry) => <span className="font-medium text-ink">{enquiry.name}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      getSortValue: (enquiry) => enquiry.source || null,
      render: (enquiry) => (enquiry.source.length > 0 ? enquiry.source : '—'),
    },
    {
      key: 'company',
      header: 'Company',
      getSortValue: (enquiry) =>
        enquiry.companyId === null ? null : (companyNameById.get(enquiry.companyId) ?? null),
      render: (enquiry) =>
        enquiry.companyId === null
          ? '—'
          : (companyNameById.get(enquiry.companyId) ?? '—'),
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (enquiry) => stageLabelById.get(enquiry.stageId) ?? null,
      render: (enquiry) => stageLabelById.get(enquiry.stageId) ?? '—',
    },
    {
      key: 'nextPlan',
      header: 'Next plan',
      getSortValue: (enquiry) => nextPlanByEnquiry.get(enquiry.id)?.date ?? null,
      render: (enquiry) => {
        const next = nextPlanByEnquiry.get(enquiry.id)

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
      getSortValue: (enquiry) =>
        enquiry.ownerId === null ? null : (members.nameById.get(enquiry.ownerId) ?? 'Unknown'),
      render: (enquiry) =>
        enquiry.ownerId === null
          ? '—'
          : (members.nameById.get(enquiry.ownerId) ?? 'Unknown'),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (enquiry) => enquiry.tags.join(', ') || null,
      render: (enquiry) =>
        enquiry.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {enquiry.tags.map((tag) => (
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
      getSortValue: (enquiry) => enquiry.summary || null,
      render: (enquiry) =>
        enquiry.summary.length === 0 ? '—' : (
          <span className="text-ink-muted">{enquiry.summary}</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (enquiry) => formatDate(enquiry.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (enquiry) => formatDate(enquiry.updatedAt, timezone),
    },
  ]

  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  const stageGroups: readonly DataTableGroup<Enquiry>[] = visibleStages.map((stage) => ({
    id: stage.id,
    label: <Chip tone={stageTone(stage)}>{stage.label}</Chip>,
    rows: visibleEnquiries.filter((enquiry) => enquiry.stageId === stage.id),
  }))

  const dueGroups: readonly DataTableGroup<Enquiry>[] = DUE_BUCKETS.map((bucket) => ({
    id: bucket.id,
    label: bucket.label,
    rows: visibleEnquiries
      .filter(
        (enquiry) => dueBucketFor(nextPlanByEnquiry.get(enquiry.id)?.date) === bucket.id,
      )
      .sort((left, right) => {
        const leftNext = nextPlanByEnquiry.get(left.id)
        const rightNext = nextPlanByEnquiry.get(right.id)

        if (leftNext === undefined || rightNext === undefined) {
          return left.name.localeCompare(right.name)
        }

        return byDateThenTitle(leftNext, rightNext) || left.name.localeCompare(right.name)
      }),
  }))

  const cards = visibleEnquiries.map((enquiry) => {
    const next = nextPlanByEnquiry.get(enquiry.id)
    const companyName =
      enquiry.companyId === null ? undefined : companyNameById.get(enquiry.companyId)
    const meta = [
      enquiry.source.length > 0 ? enquiry.source : undefined,
      companyName,
      next?.title,
    ]
      .filter((part) => part !== undefined)
      .join(' · ')

    return {
      id: enquiry.id,
      stage: enquiry.stageId,
      title: enquiry.name,
      meta,
      href: `/enquiries/${enquiry.id}`,
    }
  })

  const isLoading = enquiries.isLoading || stages.isLoading
  const loadError = enquiries.error ?? stages.error

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Enquiries"
        onAdd={() => {
          void addEnquiry()
        }}
        addLabel="Add enquiry"
        actions={
          <>
            <Link
              to="/enquiries/settings"
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

      {createEnquiry.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createEnquiry.error} />
        </div>
      )}

      {loadError !== null ? (
        <ErrorPanel error={loadError} />
      ) : isLoading ? (
        <LoadingPanel label="Loading enquiries…" />
      ) : (
        <>
          {view === 'list' && <Paginator list={enquiries} placement="top" />}
          {view === 'columns' ? (
            <KanbanBoard
              stages={visibleStages.map((stage) => ({ id: stage.id, label: stage.label }))}
              cards={cards}
              onMove={(enquiryId, stageId) => {
                const enquiry = enquiries.records.find(
                  (candidate) => candidate.id === enquiryId,
                )

                if (enquiry !== undefined && enquiry.stageId !== stageId) {
                  updateEnquiry.run({ id: enquiryId, changes: { stageId } })
                }
              }}
            />
          ) : (
            <DataTable
              columns={columns}
              groups={grouping === 'stage' ? stageGroups : dueGroups}
              getRowId={(enquiry) => enquiry.id}
              onRowClick={(enquiry) => {
                void navigate(`/enquiries/${enquiry.id}`)
              }}
              emptyMessage={
                enquiries.records.length === 0
                  ? 'No enquiries yet'
                  : scope === 'open'
                    ? 'No open enquiries'
                    : 'No enquiries in this view'
              }
              emptyDescription={
                enquiries.records.length > 0 && scope === 'open'
                  ? 'You have enquiries, but none are open right now.'
                  : undefined
              }
              emptyAction={
                enquiries.records.length === 0
                  ? {
                      label: 'Add enquiry',
                      onClick: () => {
                        void addEnquiry()
                      },
                    }
                  : scope === 'open'
                    ? {
                        label: 'Show all enquiries',
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
          {updateEnquiry.error !== null && (
            <div className="mt-3">
              <ErrorPanel error={updateEnquiry.error} />
            </div>
          )}
          {view === 'list' && <Paginator list={enquiries} />}
          {companies.hasNext && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More companies exist than one page returns, so some company names may show as “—”.
            </p>
          )}
          {plansTruncated && (
            <p className="mt-2 text-[11px] text-ink-faint">
              More plan items exist than one page returns, so some enquiries may show no next
              plan.
            </p>
          )}
        </>
      )}
    </div>
  )
}

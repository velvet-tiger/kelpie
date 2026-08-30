import type { Decision, RecordTargetType } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCompanies } from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { useDecisions } from '../api/resources/decisions.ts'
import { useMembers } from '../api/resources/members.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePartnerships } from '../api/resources/partnerships.ts'
import { usePeople } from '../api/resources/people.ts'
import { useRaises } from '../api/resources/raises.ts'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { formatDate } from '../lib/dates.ts'
import { serverSortOnly } from '../lib/sort.ts'
import { useListView } from '../lib/listView.ts'

/**
 * Every decision in the workspace.
 *
 * The filter box is the API's `?q=`, not a client-side scan of an array, so it
 * matches target names the loaded page may not even hold.
 *
 * The "Linked to" column joins client-side against one page each of people,
 * companies, deals, opportunities, raises and partnerships, because `api.md`
 * has no include-expansion and no list takes a set of bare ids. A target past
 * those pages, or one whose type has no page yet (candidate), names its record
 * type instead — better than a raw id or a link to a route that does not exist.
 */

/** `api.md`: `?limit=` maxes out at 200. */
const MAX_PAGE = 200

const TARGET_LABELS: Readonly<Record<RecordTargetType, string>> = {
  person: 'Person',
  company: 'Company',
  deal: 'Deal',
  opportunity: 'Opportunity',
  partnership: 'Partnership',
  raise: 'Raise',
  enquiry: 'Enquiry',
  candidate: 'Candidate',
}

const TARGET_ROUTES: Readonly<Partial<Record<RecordTargetType, string>>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  opportunity: '/opportunities',
  raise: '/fundraising',
  partnership: '/partnerships',
  enquiry: '/enquiries',
}

interface TargetDirectory {
  nameFor(decision: Decision): string | undefined
  readonly isComplete: boolean
}

function useTargetDirectory(): TargetDirectory {
  const people = usePeople({ limit: MAX_PAGE })
  const companies = useCompanies({ limit: MAX_PAGE })
  const deals = useDeals({ limit: MAX_PAGE })
  const opportunities = useOpportunities({ limit: MAX_PAGE })
  const raises = useRaises({ limit: MAX_PAGE })
  const partnerships = usePartnerships({ limit: MAX_PAGE })

  const nameById = useMemo(
    () =>
      new Map(
        [
          ...people.records,
          ...companies.records,
          ...deals.records,
          ...opportunities.records,
          ...raises.records,
          ...partnerships.records,
        ].map((record) => [record.id, record.name]),
      ),
    [
      people.records,
      companies.records,
      deals.records,
      opportunities.records,
      raises.records,
      partnerships.records,
    ],
  )

  return {
    nameFor: (decision) => nameById.get(decision.targetId),
    isComplete:
      !people.hasNext &&
      !companies.hasNext &&
      !deals.hasNext &&
      !opportunities.hasNext &&
      !raises.hasNext &&
      !partnerships.hasNext,
  }
}

function LinkedTo({
  decision,
  name,
}: {
  readonly decision: Decision
  readonly name: string | undefined
}): React.JSX.Element {
  const label = TARGET_LABELS[decision.targetType]
  const route = TARGET_ROUTES[decision.targetType]

  if (route === undefined) {
    return <span className="text-ink-muted">{label}</span>
  }

  return (
    <>
      <Link to={`${route}/${decision.targetId}`} className="text-accent hover:underline">
        {name ?? label}
      </Link>
      {name !== undefined && <div className="text-[11px] text-ink-faint">{label}</div>}
    </>
  )
}

const DEFAULT_VISIBLE_KEYS: readonly string[] = ['decision', 'target', 'decided', 'due', 'owner']

const SERVER_SORT_KEYS: readonly string[] = ['decided_at', 'created_at', 'updated_at']

export function DecisionsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const decisions = useDecisions({
    term: term.trim().length > 0 ? term.trim() : undefined,
    sort: serverSortOnly(sort, SERVER_SORT_KEYS),
  })
  const directory = useTargetDirectory()
  const members = useMembers()
  const timezone = useTimezone()

  const columns: readonly Column<Decision>[] = [
    {
      key: 'decision',
      header: 'Decision',
      getSortValue: (decision) => decision.body,
      render: (decision) => (
        <>
          <div className="font-medium text-ink">{decision.body}</div>
          {decision.rationale !== null && (
            <div className="mt-0.5 text-[12px] text-ink-muted">{decision.rationale}</div>
          )}
        </>
      ),
    },
    {
      key: 'rationale',
      header: 'Rationale',
      getSortValue: (decision) => decision.rationale,
      render: (decision) =>
        decision.rationale === null ? (
          '—'
        ) : (
          <span className="text-ink-muted">{decision.rationale}</span>
        ),
    },
    {
      key: 'target',
      header: 'Linked to',
      getSortValue: (decision) => directory.nameFor(decision) ?? TARGET_LABELS[decision.targetType],
      render: (decision) => <LinkedTo decision={decision} name={directory.nameFor(decision)} />,
    },
    {
      key: 'targetType',
      header: 'Type',
      getSortValue: (decision) => TARGET_LABELS[decision.targetType],
      render: (decision) => TARGET_LABELS[decision.targetType],
    },
    {
      key: 'decided',
      header: 'Decided',
      sortKey: 'decided_at',
      render: (decision) => (
        <span className="text-ink-muted">{formatDate(decision.decidedAt, timezone)}</span>
      ),
    },
    {
      key: 'due',
      header: 'By',
      getSortValue: (decision) => decision.dueAt,
      render: (decision) => (
        <span className="text-ink-muted">
          {decision.dueAt === null ? '—' : formatDate(decision.dueAt, timezone)}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      getSortValue: (decision) =>
        decision.ownerId === null ? null : (members.nameById.get(decision.ownerId) ?? null),
      render: (decision) => (
        <span className="text-ink-muted">
          {decision.ownerId === null ? '—' : (members.nameById.get(decision.ownerId) ?? '—')}
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (decision) => formatDate(decision.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (decision) => formatDate(decision.updatedAt, timezone),
    },
  ]

  const supportedKeys = columns.map((column) => column.key)
  const listView = useListView('decisions', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Decisions"
        actions={
          <ColumnPicker
            options={pickerOptions}
            visibleKeys={listView.visibleKeys}
            onChange={listView.setVisibleKeys}
          />
        }
      />
      <FilterBar value={term} onChange={setTerm} placeholder="Filter decisions…" />

      {decisions.error !== null ? (
        <ErrorPanel error={decisions.error} />
      ) : decisions.isLoading ? (
        <LoadingPanel label="Loading decisions…" />
      ) : (
        <>
          <Paginator list={decisions} placement="top" />
          <DataTable
            columns={columns}
            rows={decisions.records}
            getRowId={(decision) => decision.id}
            emptyMessage="No decisions match"
            sort={sort}
            onSortChange={setSort}
            visibleColumnKeys={listView.visibleKeys}
          />
          {!directory.isComplete && (
            <p className="mt-2 text-[11px] text-ink-faint">
              The workspace holds more records than one page returns, so some rows name only their
              record type.
            </p>
          )}
          <Paginator list={decisions} />
        </>
      )}
    </div>
  )
}

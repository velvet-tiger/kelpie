import type { Decision, RecordTargetType } from '@kelpie/schemas'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { useCompanies } from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { useDecisions } from '../api/resources/decisions.ts'
import { useMembers } from '../api/resources/members.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePeople } from '../api/resources/people.ts'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { formatDate } from '../lib/dates.ts'

/**
 * Every decision in the workspace.
 *
 * The filter box is the API's `?q=`, not a client-side scan of an array, so it
 * matches target names the loaded page may not even hold.
 *
 * The "Linked to" column joins client-side against one page each of people,
 * companies, deals and opportunities, because `api.md` has no include-expansion
 * and no list takes a set of bare ids. A target past those pages, or one whose
 * type has no page yet (partnership, raise, candidate), names its record type
 * instead — better than a raw id or a link to a route that does not exist.
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
  candidate: 'Candidate',
}

const TARGET_ROUTES: Readonly<Partial<Record<RecordTargetType, string>>> = {
  person: '/people',
  company: '/companies',
  deal: '/deals',
  opportunity: '/opportunities',
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

  const nameById = useMemo(
    () =>
      new Map(
        [
          ...people.records,
          ...companies.records,
          ...deals.records,
          ...opportunities.records,
        ].map((record) => [record.id, record.name]),
      ),
    [people.records, companies.records, deals.records, opportunities.records],
  )

  return {
    nameFor: (decision) => nameById.get(decision.targetId),
    isComplete:
      !people.hasMore && !companies.hasMore && !deals.hasMore && !opportunities.hasMore,
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

export function DecisionsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const decisions = useDecisions({ term: term.trim().length > 0 ? term.trim() : undefined })
  const directory = useTargetDirectory()
  const members = useMembers()

  const columns: readonly Column<Decision>[] = [
    {
      key: 'decision',
      header: 'Decision',
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
      key: 'target',
      header: 'Linked to',
      render: (decision) => <LinkedTo decision={decision} name={directory.nameFor(decision)} />,
    },
    {
      key: 'decided',
      header: 'Decided',
      render: (decision) => <span className="text-ink-muted">{formatDate(decision.decidedAt)}</span>,
    },
    {
      key: 'due',
      header: 'By',
      render: (decision) => (
        <span className="text-ink-muted">
          {decision.dueAt === null ? '—' : formatDate(decision.dueAt)}
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (decision) => (
        <span className="text-ink-muted">
          {decision.ownerId === null ? '—' : (members.nameById.get(decision.ownerId) ?? '—')}
        </span>
      ),
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader title="Decisions" />
      <FilterBar value={term} onChange={setTerm} placeholder="Filter decisions…" />

      {decisions.error !== null ? (
        <ErrorPanel error={decisions.error} />
      ) : decisions.isLoading ? (
        <LoadingPanel label="Loading decisions…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={decisions.records}
            getRowId={(decision) => decision.id}
            emptyMessage="No decisions match"
          />
          {!directory.isComplete && (
            <p className="mt-2 text-[11px] text-ink-faint">
              The workspace holds more records than one page returns, so some rows name only their
              record type.
            </p>
          )}
          {decisions.hasMore && (
            <button
              type="button"
              onClick={decisions.loadMore}
              disabled={decisions.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {decisions.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

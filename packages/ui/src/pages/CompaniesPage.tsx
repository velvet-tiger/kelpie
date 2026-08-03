import type { Company, IcpFit } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useCompanies, useCreateCompany } from '../api/resources/companies.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { useCompanyHeadcounts } from './positionDirectory.ts'

/**
 * The Companies list.
 *
 * The mockup's Deals column is absent: Deals have tables and a module but no
 * routes, so there is nothing to count. It returns with that endpoint rather
 * than as a zero that means "not built".
 */

const ICP_TONES: Readonly<Record<IcpFit, ChipTone>> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
  unknown: 'neutral',
}

export function CompaniesPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const navigate = useNavigate()
  const companies = useCompanies({ term: term.trim().length > 0 ? term.trim() : undefined })
  const headcounts = useCompanyHeadcounts(companies.records.map((company) => company.id))
  const createCompany = useCreateCompany()

  async function addCompany(): Promise<void> {
    const company = await createCompany.runAsync({ name: 'New company' })

    await navigate(`/companies/${company.id}`)
  }

  const columns: readonly Column<Company>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (company) => <span className="font-medium">{company.name}</span>,
    },
    {
      key: 'domain',
      header: 'Domain',
      render: (company) => (
        <span className="font-mono text-[12px] text-ink-muted">{company.domain ?? '—'}</span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (company) => <span className="capitalize">{company.accountType}</span>,
    },
    {
      key: 'icp',
      header: 'ICP fit',
      render: (company) => <Chip tone={ICP_TONES[company.icpFit]}>{company.icpFit}</Chip>,
    },
    {
      key: 'people',
      header: 'People',
      className: 'w-20',
      render: (company) => (
        <span className="font-mono text-[12px]">{headcounts.countFor(company.id)}</span>
      ),
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Companies"
        onAdd={() => {
          void addCompany()
        }}
        addLabel="Add company"
      />
      <FilterBar value={term} onChange={setTerm} placeholder="Filter by name, type, tags…" />

      {createCompany.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createCompany.error} />
        </div>
      )}

      {companies.error !== null ? (
        <ErrorPanel error={companies.error} />
      ) : companies.isLoading ? (
        <LoadingPanel label="Loading companies…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={companies.records}
            getRowId={(company) => company.id}
            onRowClick={(company) => {
              void navigate(`/companies/${company.id}`)
            }}
            emptyMessage="No companies match this filter"
          />
          {!headcounts.isComplete && !headcounts.isLoading && (
            <p className="mt-2 text-[11px] text-ink-faint">
              These companies hold more positions than one page returns, so the counts below are
              a floor rather than a total.
            </p>
          )}
          {companies.hasMore && (
            <button
              type="button"
              onClick={companies.loadMore}
              disabled={companies.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {companies.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

import type { Company, IcpFit } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCompanies, useCreateCompany } from '../api/resources/companies.ts'
import { Chip } from '../components/Chip.tsx'
import type { ChipTone } from '../components/Chip.tsx'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { formatDate } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { serverSortOnly } from '../lib/sort.ts'
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

const DEFAULT_VISIBLE_KEYS: readonly string[] = ['name', 'domain', 'hq', 'type', 'updatedAt']

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function CompaniesPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const navigate = useNavigate()
  const timezone = useTimezone()
  const hasFilter = term.trim().length > 0
  const companies = useCompanies({
    term: hasFilter ? term.trim() : undefined,
    sort: serverSortOnly(sort, SERVER_SORT_KEYS),
  })
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
      sortKey: 'name',
      render: (company) => <span className="font-medium">{company.name}</span>,
    },
    {
      key: 'domain',
      header: 'Domain',
      getSortValue: (company) => company.domain,
      render: (company) => (
        <span className="font-mono text-[12px] text-ink-muted">{company.domain ?? '—'}</span>
      ),
    },
    {
      key: 'website',
      header: 'Website',
      getSortValue: (company) => company.website,
      render: (company) => (
        <span className="font-mono text-[12px] text-ink-muted">{company.website ?? '—'}</span>
      ),
    },
    {
      key: 'industry',
      header: 'Industry',
      getSortValue: (company) => company.industry,
      render: (company) => company.industry ?? '—',
    },
    {
      key: 'hq',
      header: 'HQ',
      getSortValue: (company) => company.hq,
      render: (company) => company.hq ?? '—',
    },
    {
      key: 'type',
      header: 'Type',
      getSortValue: (company) => company.accountType,
      render: (company) => <span className="capitalize">{company.accountType}</span>,
    },
    {
      key: 'stage',
      header: 'Stage',
      getSortValue: (company) => company.stage,
      render: (company) => <span className="capitalize">{company.stage}</span>,
    },
    {
      key: 'sizeBand',
      header: 'Size',
      getSortValue: (company) => company.sizeBand,
      render: (company) => company.sizeBand,
    },
    {
      key: 'icp',
      header: 'ICP fit',
      getSortValue: (company) => company.icpFit,
      render: (company) => <Chip tone={ICP_TONES[company.icpFit]}>{company.icpFit}</Chip>,
    },
    {
      key: 'techStack',
      header: 'Tech stack',
      getSortValue: (company) => company.techStack.join(', ') || null,
      render: (company) =>
        company.techStack.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {company.techStack.map((entry) => (
              <Chip key={entry}>
                <span className="text-[10px]">{entry}</span>
              </Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'description',
      header: 'Description',
      getSortValue: (company) => company.description || null,
      render: (company) =>
        company.description.length === 0 ? '—' : (
          <span className="text-ink-muted">{company.description}</span>
        ),
    },
    {
      key: 'summary',
      header: 'Summary',
      getSortValue: (company) => company.summary || null,
      render: (company) =>
        company.summary.length === 0 ? '—' : (
          <span className="text-ink-muted">{company.summary}</span>
        ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (company) => company.tags.join(', ') || null,
      render: (company) =>
        company.tags.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {company.tags.map((tag) => (
              <Chip key={tag}>
                <span className="text-[10px]">{tag}</span>
              </Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'people',
      header: 'People',
      className: 'w-20',
      getSortValue: (company) => headcounts.countFor(company.id),
      render: (company) => (
        <span className="font-mono text-[12px]">{headcounts.countFor(company.id)}</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (company) => formatDate(company.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (company) => formatDate(company.updatedAt, timezone),
    },
  ]

  const supportedKeys = columns.map((column) => column.key)
  const listView = useListView('companies', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Companies"
        onAdd={() => {
          void addCompany()
        }}
        addLabel="Add company"
        actions={
          <ColumnPicker
            options={pickerOptions}
            visibleKeys={listView.visibleKeys}
            onChange={listView.setVisibleKeys}
          />
        }
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
            emptyMessage={hasFilter ? 'No companies match this filter' : 'No companies yet'}
            emptyDescription={hasFilter ? 'Try a different search term.' : undefined}
            emptyAction={
              hasFilter
                ? undefined
                : {
                    label: 'Add company',
                    onClick: () => {
                      void addCompany()
                    },
                  }
            }
            sort={sort}
            onSortChange={setSort}
            visibleColumnKeys={listView.visibleKeys}
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

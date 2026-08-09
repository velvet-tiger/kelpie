import type { Form } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreateForm, useForms } from '../api/resources/forms.ts'
import { Chip } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { CONTACT_FORM_FIELDS } from './forms/template.ts'

/**
 * Every form in the workspace.
 *
 * The filter box and the status toggle are both the API's, not a scan of a
 * loaded array, so they match forms this page has not paged to yet.
 *
 * There is no submissions count column. The mockup had one because its seed data
 * was a local array; here it would be one request per row, and `api.md` has no
 * expansion to fold that into the list. The count lives on the detail page,
 * where the submissions are already being fetched.
 */

type StatusFilter = 'all' | 'active' | 'paused'

const STATUS_OPTIONS = [
  { id: 'all' as const, label: 'All' },
  { id: 'active' as const, label: 'Active' },
  { id: 'paused' as const, label: 'Paused' },
]

export function FormsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const navigate = useNavigate()
  const hasFilter = term.trim().length > 0 || status !== 'all'
  const createForm = useCreateForm()
  const forms = useForms({
    term: term.trim().length > 0 ? term.trim() : undefined,
    ...(status === 'all' ? {} : { status }),
    sort,
  })

  /**
   * A new form starts as the contact template rather than empty, because an
   * empty field list is not a form the API will accept: it needs a
   * `person.email` mapping before it can process anything.
   */
  function addForm(): void {
    createForm
      .runAsync({ name: 'New form', fields: CONTACT_FORM_FIELDS })
      .then((form) => navigate(`/forms/${form.id}`))
      .catch(() => undefined)
  }

  const columns: readonly Column<Form>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      render: (form) => (
        <>
          <div className="font-medium text-ink">{form.name}</div>
          {form.description !== null && form.description.length > 0 && (
            <div className="mt-0.5 text-[12px] text-ink-muted">{form.description}</div>
          )}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-28',
      render: (form) => (
        <Chip tone={form.status === 'active' ? 'success' : 'neutral'}>{form.status}</Chip>
      ),
    },
    {
      key: 'fields',
      header: 'Fields',
      className: 'w-20',
      render: (form) => <span className="font-mono text-[12px]">{form.fields.length}</span>,
    },
    {
      key: 'deal',
      header: 'Deal',
      className: 'w-32',
      render: (form) =>
        form.createDeal ? (
          <Chip tone="accent">Creates deal</Chip>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Forms"
        description="Embeddable forms that create People, Companies, and optional Deals."
        onAdd={addForm}
        addLabel="New form"
        actions={
          <SegmentedControl
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
          />
        }
      />
      <FilterBar value={term} onChange={setTerm} placeholder="Filter forms…" />

      {createForm.error !== null && <ErrorPanel error={createForm.error} />}

      {forms.error !== null ? (
        <ErrorPanel error={forms.error} />
      ) : forms.isLoading ? (
        <LoadingPanel label="Loading forms…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={forms.records}
            getRowId={(form) => form.id}
            onRowClick={(form) => navigate(`/forms/${form.id}`)}
            emptyMessage={hasFilter ? 'No forms match this filter' : 'No forms yet'}
            emptyDescription={hasFilter ? 'Try a different search term or status.' : undefined}
            emptyAction={hasFilter ? undefined : { label: 'New form', onClick: addForm }}
            sort={sort}
            onSortChange={setSort}
          />
          {forms.hasMore && (
            <button
              type="button"
              onClick={forms.loadMore}
              disabled={forms.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {forms.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

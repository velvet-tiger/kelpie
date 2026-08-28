import type { Form } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCreateForm, useForms } from '../api/resources/forms.ts'
import { Chip } from '../components/Chip.tsx'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { SegmentedControl } from '../components/SegmentedControl.tsx'
import { formatDate } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { serverSortOnly } from '../lib/sort.ts'
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

const DEFAULT_VISIBLE_KEYS: readonly string[] = ['name', 'status', 'fields', 'deal']

const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

export function FormsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const navigate = useNavigate()
  const hasFilter = term.trim().length > 0 || status !== 'all'
  const createForm = useCreateForm()
  const timezone = useTimezone()
  const forms = useForms({
    term: term.trim().length > 0 ? term.trim() : undefined,
    ...(status === 'all' ? {} : { status }),
    sort: serverSortOnly(sort, SERVER_SORT_KEYS),
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
      key: 'description',
      header: 'Description',
      getSortValue: (form) => form.description,
      render: (form) => form.description ?? '—',
    },
    {
      key: 'status',
      header: 'Status',
      className: 'w-28',
      getSortValue: (form) => form.status,
      render: (form) => (
        <Chip tone={form.status === 'active' ? 'success' : 'neutral'}>{form.status}</Chip>
      ),
    },
    {
      key: 'fields',
      header: 'Fields',
      className: 'w-20',
      getSortValue: (form) => form.fields.length,
      render: (form) => <span className="font-mono text-[12px]">{form.fields.length}</span>,
    },
    {
      key: 'deal',
      header: 'Deal',
      className: 'w-32',
      getSortValue: (form) => form.createDeal,
      render: (form) =>
        form.createDeal ? (
          <Chip tone="accent">Creates deal</Chip>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      key: 'dealNameTemplate',
      header: 'Deal name template',
      getSortValue: (form) => form.dealNameTemplate,
      render: (form) =>
        form.dealNameTemplate === null ? (
          '—'
        ) : (
          <span className="font-mono text-[12px] text-ink-muted">{form.dealNameTemplate}</span>
        ),
    },
    {
      key: 'thankYouMessage',
      header: 'Thank-you',
      getSortValue: (form) => form.thankYouMessage || null,
      render: (form) =>
        form.thankYouMessage.length === 0 ? '—' : (
          <span className="text-ink-muted">{form.thankYouMessage}</span>
        ),
    },
    {
      key: 'publicKey',
      header: 'Public key',
      getSortValue: (form) => form.publicKey,
      render: (form) => (
        <span className="font-mono text-[12px] text-ink-muted">{form.publicKey}</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (form) => formatDate(form.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (form) => formatDate(form.updatedAt, timezone),
    },
  ]

  const supportedKeys = columns.map((column) => column.key)
  const listView = useListView('forms', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Forms"
        description="Embeddable forms that create People, Companies, and optional Deals."
        onAdd={addForm}
        addLabel="New form"
        actions={
          <>
            <SegmentedControl
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              ariaLabel="Filter by status"
            />
            <ColumnPicker
              options={pickerOptions}
              visibleKeys={listView.visibleKeys}
              onChange={listView.setVisibleKeys}
            />
          </>
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
          <Paginator list={forms} placement="top" />
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
            visibleColumnKeys={listView.visibleKeys}
          />
          <Paginator list={forms} />
        </>
      )}
    </div>
  )
}

import { useState } from 'react'

import { useCompanies } from '../api/resources/companies.ts'
import { EntitySearch } from './EntitySearch.tsx'
import type { SearchOption } from './EntitySearch.tsx'

/**
 * Asks for a record's name before the record exists.
 *
 * A list page's Add button opens this instead of creating a record with a
 * placeholder name. The created event then carries the real name, which is what
 * a webhook, an agent task or a notification reads. Nothing is saved when the
 * reader cancels.
 *
 * `company` adds a required company picker, for the records that belong to one
 * (deals, raises, partnerships).
 */

export interface AddRecordValues {
  readonly name: string
  /** Set only when the panel was given `company`. */
  readonly companyId?: string
}

export interface AddRecordCompanyPicker {
  readonly options: readonly SearchOption[]
  /** Set to search on the server as the reader types. */
  readonly onQueryChange?: (query: string) => void
}

export interface AddRecordPanelProps {
  /** The heading and the submit label, e.g. "Add person". */
  readonly title: string
  readonly namePlaceholder?: string
  readonly company?: AddRecordCompanyPicker
  readonly isPending: boolean
  readonly onCancel: () => void
  readonly onCreate: (values: AddRecordValues) => void
}

export function AddRecordPanel({
  title,
  namePlaceholder,
  company,
  isPending,
  onCancel,
  onCreate,
}: AddRecordPanelProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [companyId, setCompanyId] = useState('')
  const trimmed = name.trim()
  const ready = trimmed.length > 0 && (company === undefined || companyId.length > 0)

  return (
    <form
      aria-label={title}
      className="mb-3 max-w-md rounded-md border border-border bg-surface-raised p-4"
      onSubmit={(event) => {
        event.preventDefault()

        if (!ready || isPending) {
          return
        }

        onCreate(company === undefined ? { name: trimmed } : { name: trimmed, companyId })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isPending) {
          onCancel()
        }
      }}
    >
      <p className="text-[13px] font-semibold text-ink">{title}</p>

      <div className="mt-3 space-y-3">
        <label className="block text-[12px] font-medium text-ink-muted">
          Name
          <input
            // The reader pressed Add to type a name, so the caret starts here.
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            placeholder={namePlaceholder}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink"
          />
        </label>

        {company !== undefined && (
          <div className="text-[12px] font-medium text-ink-muted">
            Company
            <div className="mt-1">
              <EntitySearch
                options={company.options}
                value={companyId}
                onChange={setCompanyId}
                onQueryChange={company.onQueryChange}
                placeholder="Search companies…"
                emptyMessage="No company matches"
                size="sm"
              />
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !ready}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {isPending ? 'Adding…' : title}
        </button>
      </div>
    </form>
  )
}

/** `AddRecordPanel` with the company picker searching the workspace's companies. */
export function AddCompanyRecordPanel(props: Omit<AddRecordPanelProps, 'company'>): React.JSX.Element {
  const [search, setSearch] = useState('')
  const companies = useCompanies({ term: search.trim().length > 0 ? search.trim() : undefined })

  return (
    <AddRecordPanel
      {...props}
      company={{
        options: companies.records.map((company) => ({ id: company.id, label: company.name })),
        onQueryChange: setSearch,
      }}
    />
  )
}

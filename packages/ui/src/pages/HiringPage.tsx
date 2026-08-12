import type { Role } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCreateRole, useRoles } from '../api/resources/roles.ts'
import { Chip } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { formatDate } from '../lib/dates.ts'
import { useRoleCandidateCounts } from './hiringDirectory.ts'

/**
 * The Hiring list: every opening, open or closed.
 *
 * The filter box is the API's `?q=` rather than a scan of an array, the change
 * every ported list page makes. Adding a role asks for a title first, because a
 * role with a placeholder name is worse than one keystroke of friction.
 */
export function HiringPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const navigate = useNavigate()
  const roles = useRoles({ term: term.trim().length > 0 ? term.trim() : undefined })
  const counts = useRoleCandidateCounts(roles.records.map((role) => role.id))
  const createRole = useCreateRole()
  const timezone = useTimezone()

  function reset(): void {
    setAdding(false)
    setTitle('')
  }

  async function addRole(event: FormEvent): Promise<void> {
    event.preventDefault()

    const trimmed = title.trim()

    if (trimmed.length === 0) {
      return
    }

    const role = await createRole.runAsync({ title: trimmed })

    reset()
    await navigate(`/hiring/${role.id}`)
  }

  const columns: readonly Column<Role>[] = [
    {
      key: 'title',
      header: 'Role',
      render: (role) => <span className="font-medium text-ink">{role.title}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (role) => (
        <Chip tone={role.status === 'open' ? 'accent' : 'neutral'}>
          {role.status === 'open' ? 'Open' : 'Closed'}
        </Chip>
      ),
    },
    {
      key: 'candidates',
      header: 'Candidates',
      className: 'w-28',
      render: (role) => (
        <span className="font-mono text-[12px]">
          {counts.isLoading ? '—' : counts.countFor(role.id)}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      render: (role) => formatDate(role.createdAt, timezone),
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Hiring"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add role"
      />

      {adding && (
        <form
          onSubmit={(event) => {
            void addRole(event)
          }}
          className="mb-4 flex max-w-md gap-2"
        >
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
            }}
            placeholder="Role title"
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[13px] outline-none focus:border-accent"
            required
          />
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createRole.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
          >
            Add
          </button>
        </form>
      )}

      <FilterBar value={term} onChange={setTerm} placeholder="Filter roles…" />

      {createRole.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createRole.error} />
        </div>
      )}

      {roles.error !== null ? (
        <ErrorPanel error={roles.error} />
      ) : roles.isLoading ? (
        <LoadingPanel label="Loading roles…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={roles.records}
            getRowId={(role) => role.id}
            onRowClick={(role) => {
              void navigate(`/hiring/${role.id}`)
            }}
            emptyMessage="No roles yet"
          />
          {!counts.isComplete && !counts.isLoading && (
            <p className="mt-2 text-[11px] text-ink-faint">
              These roles hold more candidates than one page returns, so some counts read low.
            </p>
          )}
          {roles.hasMore && (
            <button
              type="button"
              onClick={roles.loadMore}
              disabled={roles.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {roles.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

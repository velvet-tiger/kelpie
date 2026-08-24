import {
  RECORD_TARGET_TYPE_LABELS,
  RECORD_TARGET_TYPES,
} from '@kelpie/schemas'
import type { List, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'

import { useCreateList, useLists } from '../api/resources/lists.ts'
import { Chip } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'

/**
 * The Lists index.
 *
 * A list holds records of one type, chosen at creation and never changed. The
 * "Add list" button opens a small inline form that captures name and type; on
 * create, the user is taken straight to the list's detail page.
 */
export function ListsPage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const hasFilter = term.trim().length > 0
  const lists = useLists({ term: hasFilter ? term.trim() : undefined })
  const createList = useCreateList()

  const columns: readonly Column<List>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (list) => <span className="font-medium text-ink">{list.name}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      render: (list) => <Chip>{RECORD_TARGET_TYPE_LABELS[list.targetType]}</Chip>,
    },
    {
      key: 'members',
      header: 'Members',
      render: (list) => String(list.memberCount),
    },
    {
      key: 'description',
      header: 'Description',
      render: (list) => list.description ?? '—',
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Lists"
        onAdd={() => {
          setCreating((current) => !current)
        }}
        addLabel="Add list"
      />

      {creating && (
        <CreateListForm
          isPending={createList.isPending}
          error={createList.error}
          onCancel={() => {
            setCreating(false)
          }}
          onSubmit={(input) => {
            createList
              .runAsync(input)
              .then((list) => {
                setCreating(false)
                return navigate(`/lists/${list.id}`)
              })
              .catch(() => undefined)
          }}
        />
      )}

      <FilterBar value={term} onChange={setTerm} placeholder="Filter by name…" />

      {lists.error !== null ? (
        <ErrorPanel error={lists.error} />
      ) : lists.isLoading ? (
        <LoadingPanel label="Loading lists…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={lists.records}
            getRowId={(list) => list.id}
            onRowClick={(list) => {
              void navigate(`/lists/${list.id}`)
            }}
            emptyMessage={hasFilter ? 'No lists match this filter' : 'No lists yet'}
            emptyDescription={
              hasFilter ? 'Try a different search term.' : 'Add a list to group records together.'
            }
            emptyAction={
              hasFilter
                ? undefined
                : {
                    label: 'Add list',
                    onClick: () => {
                      setCreating(true)
                    },
                  }
            }
          />
          {lists.hasMore && (
            <button
              type="button"
              onClick={lists.loadMore}
              disabled={lists.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {lists.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

interface CreateListFormProps {
  readonly isPending: boolean
  readonly error: Error | null
  readonly onCancel: () => void
  readonly onSubmit: (input: {
    readonly name: string
    readonly targetType: RecordTargetType
    readonly description: string | null
  }) => void
}

function CreateListForm({
  isPending,
  error,
  onCancel,
  onSubmit,
}: CreateListFormProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [targetType, setTargetType] = useState<RecordTargetType>('person')
  const [description, setDescription] = useState('')

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmed = name.trim()

    if (trimmed.length === 0) {
      return
    }

    onSubmit({
      name: trimmed,
      targetType,
      description: description.trim().length > 0 ? description.trim() : null,
    })
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 rounded-md border border-border bg-surface-raised p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
            Name
          </span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            required
            autoFocus
            placeholder="Priority people"
            className="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
            Type
          </span>
          <select
            value={targetType}
            onChange={(event) => {
              setTargetType(event.target.value as RecordTargetType)
            }}
            className="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            {RECORD_TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {RECORD_TARGET_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
            Description
          </span>
          <input
            value={description}
            onChange={(event) => {
              setDescription(event.target.value)
            }}
            placeholder="Optional"
            className="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
      </div>

      {error !== null && (
        <div className="mt-3">
          <ErrorPanel error={error} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={isPending || name.trim().length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition hover:bg-accent-strong disabled:opacity-50"
        >
          {isPending ? 'Creating…' : 'Create list'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

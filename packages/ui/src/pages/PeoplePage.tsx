import type { Person } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useCreatePerson, usePeople } from '../api/resources/people.ts'
import { Chip } from '../components/Chip.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { usePeopleDirectory } from './positionDirectory.ts'

/**
 * The People list.
 *
 * The filter box is the API's `?q=`, not a client-side scan of an array. That is
 * the whole difference from the mockup, and it means the filter matches the
 * position titles and company names the server joins in, which no client-side
 * filter over a page of people could see.
 */
export function PeoplePage(): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [sort, setSort] = useState<string | undefined>(undefined)
  const navigate = useNavigate()
  const hasFilter = term.trim().length > 0
  const people = usePeople({ term: hasFilter ? term.trim() : undefined, sort })
  const directory = usePeopleDirectory(people.records.map((person) => person.id))
  const createPerson = useCreatePerson()

  async function addPerson(): Promise<void> {
    // The same defaults the API applies, so a person created here and one
    // created through the API are the same record.
    const person = await createPerson.runAsync({ name: 'New person' })

    await navigate(`/people/${person.id}`)
  }

  const columns: readonly Column<Person>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      render: (person) => <span className="font-medium text-ink">{person.name}</span>,
    },
    {
      key: 'position',
      header: 'Position',
      render: (person) => directory.titleFor(person.id) ?? '—',
    },
    {
      key: 'company',
      header: 'Company',
      render: (person) => {
        const names = directory.companyNamesFor(person.id)

        return names.length > 0 ? names.join(', ') : '—'
      },
    },
    {
      key: 'tags',
      header: 'Tags',
      render: (person) =>
        person.tags.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {person.tags.map((tag) => (
              <Chip key={tag}>
                <span className="text-[10px]">{tag}</span>
              </Chip>
            ))}
          </span>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="People"
        onAdd={() => {
          void addPerson()
        }}
        addLabel="Add person"
      />
      <FilterBar
        value={term}
        onChange={setTerm}
        placeholder="Filter by name, position, company…"
      />

      {createPerson.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createPerson.error} />
        </div>
      )}

      {people.error !== null ? (
        <ErrorPanel error={people.error} />
      ) : people.isLoading ? (
        <LoadingPanel label="Loading people…" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={people.records}
            getRowId={(person) => person.id}
            onRowClick={(person) => {
              void navigate(`/people/${person.id}`)
            }}
            emptyMessage={hasFilter ? 'No people match this filter' : 'No people yet'}
            emptyDescription={hasFilter ? 'Try a different search term.' : undefined}
            emptyAction={
              hasFilter
                ? undefined
                : {
                    label: 'Add person',
                    onClick: () => {
                      void addPerson()
                    },
                  }
            }
            sort={sort}
            onSortChange={setSort}
          />
          {!directory.isComplete && !directory.isLoading && (
            <p className="mt-2 text-[11px] text-ink-faint">
              These people hold more positions than one page returns, so some rows may read “—”.
            </p>
          )}
          {people.hasMore && (
            <button
              type="button"
              onClick={people.loadMore}
              disabled={people.isLoadingMore}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken disabled:opacity-50"
            >
              {people.isLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

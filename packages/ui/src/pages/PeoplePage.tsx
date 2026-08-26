import type { Person } from '@kelpie/schemas'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import { useTimezone } from '../api/resources/account.ts'
import { useCreatePerson, usePeople } from '../api/resources/people.ts'
import { Chip } from '../components/Chip.tsx'
import { ColumnPicker } from '../components/ColumnPicker.tsx'
import { DataTable } from '../components/DataTable.tsx'
import type { Column } from '../components/DataTable.tsx'
import { FilterBar, PageHeader } from '../components/PageHeader.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { formatDate } from '../lib/dates.ts'
import { useListView } from '../lib/listView.ts'
import { serverSortOnly } from '../lib/sort.ts'
import { usePeopleDirectory } from './positionDirectory.ts'

/**
 * Column catalog for People. Every field the wire schema carries appears here,
 * plus the two joined-in columns (position title, company names) computed from
 * the position directory. `sortKey` names the server field; `getSortValue`
 * enables the DataTable's page-local sort for columns the server does not
 * index. Everything not in `DEFAULT_VISIBLE_KEYS` starts hidden and comes back
 * through the Columns picker.
 */
const DEFAULT_VISIBLE_KEYS: readonly string[] = ['name', 'email', 'phones', 'company', 'updatedAt']

/** The sort fields `/v1/people` accepts. Anything else is a client-only sort. */
const SERVER_SORT_KEYS: readonly string[] = ['name', 'created_at', 'updated_at']

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
  const timezone = useTimezone()
  const hasFilter = term.trim().length > 0
  const people = usePeople({
    term: hasFilter ? term.trim() : undefined,
    sort: serverSortOnly(sort, SERVER_SORT_KEYS),
  })
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
      getSortValue: (person) => directory.titleFor(person.id) ?? null,
      render: (person) => directory.titleFor(person.id) ?? '—',
    },
    {
      key: 'company',
      header: 'Company',
      getSortValue: (person) => directory.companyNamesFor(person.id).join(', ') || null,
      render: (person) => {
        const names = directory.companyNamesFor(person.id)

        return names.length > 0 ? names.join(', ') : '—'
      },
    },
    {
      key: 'email',
      header: 'Email',
      getSortValue: (person) => person.email,
      render: (person) =>
        person.email === null ? (
          '—'
        ) : (
          <span className="font-mono text-[12px] text-ink-muted">{person.email}</span>
        ),
    },
    {
      key: 'phones',
      header: 'Phones',
      getSortValue: (person) => person.phones.join(', ') || null,
      render: (person) =>
        person.phones.length === 0 ? '—' : (
          <span className="font-mono text-[12px] text-ink-muted">{person.phones.join(', ')}</span>
        ),
    },
    {
      key: 'socials',
      header: 'Socials',
      getSortValue: (person) => person.socialProfiles.map((entry) => entry.network).join(', ') || null,
      render: (person) =>
        person.socialProfiles.length === 0 ? '—' : (
          <span className="flex flex-wrap gap-1">
            {person.socialProfiles.map((entry) => (
              <Chip key={entry.network}>
                <span className="text-[10px]">{entry.network}</span>
              </Chip>
            ))}
          </span>
        ),
    },
    {
      key: 'location',
      header: 'Location',
      getSortValue: (person) => person.location,
      render: (person) => person.location ?? '—',
    },
    {
      key: 'timezone',
      header: 'Timezone',
      getSortValue: (person) => person.timezone,
      render: (person) =>
        person.timezone === null ? '—' : (
          <span className="font-mono text-[12px] text-ink-muted">{person.timezone}</span>
        ),
    },
    {
      key: 'preferredChannel',
      header: 'Preferred channel',
      getSortValue: (person) => person.preferredChannel,
      render: (person) => <span className="capitalize">{person.preferredChannel}</span>,
    },
    {
      key: 'influence',
      header: 'Influence',
      getSortValue: (person) => person.influence,
      render: (person) => <span className="capitalize">{person.influence.replace('_', ' ')}</span>,
    },
    {
      key: 'relationship',
      header: 'Relationship',
      getSortValue: (person) => person.relationship,
      render: (person) => <span className="capitalize">{person.relationship}</span>,
    },
    {
      key: 'summary',
      header: 'Summary',
      getSortValue: (person) => person.summary || null,
      render: (person) =>
        person.summary.length === 0 ? '—' : (
          <span className="text-ink-muted">{person.summary}</span>
        ),
    },
    {
      key: 'tags',
      header: 'Tags',
      getSortValue: (person) => person.tags.join(', ') || null,
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
    {
      key: 'lastContactedAt',
      header: 'Last contacted',
      getSortValue: (person) => person.lastContactedAt,
      render: (person) =>
        person.lastContactedAt === null ? '—' : formatDate(person.lastContactedAt, timezone),
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortKey: 'created_at',
      render: (person) => formatDate(person.createdAt, timezone),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      sortKey: 'updated_at',
      render: (person) => formatDate(person.updatedAt, timezone),
    },
  ]

  const supportedKeys = columns.map((column) => column.key)
  const listView = useListView('people', supportedKeys, DEFAULT_VISIBLE_KEYS)
  const pickerOptions = columns.map((column) => ({ key: column.key, label: column.header }))

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="People"
        onAdd={() => {
          void addPerson()
        }}
        addLabel="Add person"
        actions={
          <ColumnPicker
            options={pickerOptions}
            visibleKeys={listView.visibleKeys}
            onChange={listView.setVisibleKeys}
          />
        }
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
            visibleColumnKeys={listView.visibleKeys}
          />
          {!directory.isComplete && !directory.isLoading && (
            <p className="mt-2 text-[11px] text-ink-faint">
              These people hold more positions than one page returns, so some rows may read “—”.
            </p>
          )}
          <Paginator list={people} />
        </>
      )}
    </div>
  )
}

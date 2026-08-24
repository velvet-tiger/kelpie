import { RECORD_TARGET_TYPE_LABELS } from '@kelpie/schemas'
import type { List, ListMembership, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import { Link } from 'react-router'

import {
  useAddListMember,
  useListMembershipsFor,
  useRemoveListMember,
} from '../api/resources/listMembers.ts'
import { useLists } from '../api/resources/lists.ts'
import { EntitySearch } from './EntitySearch.tsx'
import type { SearchOption } from './EntitySearch.tsx'
import { ErrorPanel, LoadingPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * "What lists is this record on?" panel, for any record's detail page.
 *
 * A record can only join a list whose `target_type` matches its own, so the
 * picker is filtered accordingly. Removing a chip calls
 * `DELETE /v1/lists/{id}/members/{memberId}` and the cached counts on the
 * lists index refresh with it.
 */
export function ListsPanel({
  targetType,
  targetId,
}: {
  readonly targetType: RecordTargetType
  readonly targetId: string
}): React.JSX.Element {
  const memberships = useListMembershipsFor(targetType, targetId)
  const [adding, setAdding] = useState(false)

  return (
    <section>
      <SectionHeader
        title="Lists"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add to list"
      />

      {adding && (
        <div className="mb-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <ListPicker
              targetType={targetType}
              targetId={targetId}
              excludeListIds={new Set(memberships.memberships.map((row) => row.listId))}
              onAdded={() => {
                setAdding(false)
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setAdding(false)
            }}
            className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
      )}

      {memberships.error !== null && <ErrorPanel error={memberships.error} />}

      {memberships.isLoading ? (
        <LoadingPanel label="Loading lists…" />
      ) : memberships.memberships.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">
          Not on any lists yet. Add this {RECORD_TARGET_TYPE_LABELS[targetType].toLowerCase()} to
          a list to group it with others.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-border">
          {memberships.memberships.map((membership) => (
            <MembershipRow key={membership.id} membership={membership} />
          ))}
        </ul>
      )}
    </section>
  )
}

function MembershipRow({
  membership,
}: {
  readonly membership: ListMembership
}): React.JSX.Element {
  const remove = useRemoveListMember()

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to={`/lists/${membership.listId}`}
          className="text-left text-[13px] font-medium text-ink hover:text-accent"
        >
          {membership.listName}
        </Link>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            remove.run({ listId: membership.listId, id: membership.id })
          }}
          className="text-[11px] font-medium text-danger hover:underline disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {remove.error !== null && (
        <div className="mt-2">
          <ErrorPanel error={remove.error} />
        </div>
      )}
    </li>
  )
}

function ListPicker({
  targetType,
  targetId,
  excludeListIds,
  onAdded,
}: {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly excludeListIds: ReadonlySet<string>
  readonly onAdded: () => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const term = search.trim()
  // Only lists whose type matches — the DB will refuse a mismatched member,
  // but the picker filters up front so the surface never offers one.
  const lists = useLists({
    targetType,
    term: term.length > 0 ? term : undefined,
  })
  const addMember = useAddListMember()

  const options: readonly SearchOption[] = lists.records
    .filter((row: List) => !excludeListIds.has(row.id))
    .map((row: List) => ({ id: row.id, label: row.name }))

  function pick(listId: string): void {
    addMember
      .runAsync({ listId, input: { targetType, targetId } })
      .then(onAdded)
      .catch(() => undefined)
  }

  return (
    <div>
      <EntitySearch
        options={options}
        value=""
        onChange={pick}
        onQueryChange={setSearch}
        placeholder="Search lists…"
        emptyMessage="No matching lists"
        size="md"
      />
      {addMember.error !== null && (
        <div className="mt-2">
          <ErrorPanel error={addMember.error} />
        </div>
      )}
    </div>
  )
}

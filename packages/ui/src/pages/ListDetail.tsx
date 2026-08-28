import { RECORD_TARGET_TYPE_LABELS } from '@kelpie/schemas'
import type { ListMember, RecordTargetType } from '@kelpie/schemas'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { usePatch } from '../api/resource.ts'
import type { PatchResult } from '../api/resource.ts'
import { useCompanies } from '../api/resources/companies.ts'
import { useDeals } from '../api/resources/deals.ts'
import { useDeleteList, useList, useUpdateList } from '../api/resources/lists.ts'
import {
  useAddListMember,
  useListMembers,
  useRemoveListMember,
} from '../api/resources/listMembers.ts'
import { useOpportunities } from '../api/resources/opportunities.ts'
import { usePartnerships } from '../api/resources/partnerships.ts'
import { usePeople } from '../api/resources/people.ts'
import { useRaises } from '../api/resources/raises.ts'
import { Chip } from '../components/Chip.tsx'
import { DeleteRecord } from '../components/DeleteRecord.tsx'
import { EntitySearch } from '../components/EntitySearch.tsx'
import type { SearchOption } from '../components/EntitySearch.tsx'
import { InlineEdit } from '../components/InlineEdit.tsx'
import { Paginator } from '../components/Paginator.tsx'
import { ErrorPanel, LoadingPanel, NotFoundPanel } from '../components/QueryState.tsx'
import { SectionHeader } from '../components/SectionHeader.tsx'
import type { List, ListInput } from '@kelpie/schemas'

/**
 * One list, and the records on it.
 *
 * The type is fixed at creation, so the header shows it as a badge and the
 * member picker below dispatches on it: a `person` list picks from people, a
 * `company` list from companies, and so on. A candidate list has no picker in
 * v1 because candidates carry no name of their own; add candidacies from the
 * hiring pages.
 */
export function ListDetail(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const { record, isLoading, isNotFound, error } = useList(id)
  const deleteList = useDeleteList()

  if (isNotFound) {
    return <NotFoundPanel label="List" backTo="/lists" />
  }

  if (error !== null) {
    return <ErrorPanel error={error} />
  }

  if (isLoading || record === undefined || id === undefined) {
    return <LoadingPanel label="Loading list…" />
  }

  return (
    <div className="animate-fade-in mx-auto max-w-4xl">
      <Link
        to="/lists"
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted transition hover:text-accent"
      >
        ← Lists
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <ListHeading list={record} />
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Chip>{RECORD_TARGET_TYPE_LABELS[record.targetType]}</Chip>
          <DeleteRecord
            recordLabel="List"
            recordName={record.name}
            isPending={deleteList.isPending}
            error={deleteList.error}
            onConfirm={() => {
              deleteList
                .runAsync(record.id)
                .then(() => navigate('/lists'))
                .catch(() => undefined)
            }}
          />
        </div>
      </div>

      <ListDescription list={record} />

      <ListMembers listId={record.id} targetType={record.targetType} />
    </div>
  )
}

function useListPatch(list: List): PatchResult<ListInput> {
  return usePatch(useUpdateList, list)
}

function ListHeading({ list }: { readonly list: List }): React.JSX.Element {
  const { patch, error } = useListPatch(list)

  return (
    <div className="min-w-0 flex-1">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={list.name}
        onChange={(name) => {
          patch({ name })
        }}
        displayClassName="text-[22px] font-semibold tracking-tight text-ink not-italic"
        emptyLabel="Untitled list"
      />
    </div>
  )
}

function ListDescription({ list }: { readonly list: List }): React.JSX.Element {
  const { patch, error } = useListPatch(list)

  return (
    <div className="mb-6">
      {error !== null && (
        <div className="mb-2">
          <ErrorPanel error={error} />
        </div>
      )}
      <InlineEdit
        value={list.description ?? ''}
        onChange={(description) => {
          patch({ description: description.length > 0 ? description : null })
        }}
        displayClassName="text-[13px] text-ink-muted not-italic"
        emptyLabel="Add a description"
        multiline
      />
    </div>
  )
}

function ListMembers({
  listId,
  targetType,
}: {
  readonly listId: string
  readonly targetType: RecordTargetType
}): React.JSX.Element {
  const members = useListMembers(listId)
  const addMember = useAddListMember()
  const [adding, setAdding] = useState(false)

  const attached = new Set(members.records.map((member) => member.targetId))

  function add(targetId: string): void {
    if (attached.has(targetId)) {
      return
    }

    addMember.run({ listId, input: { targetType, targetId } })
    setAdding(false)
  }

  return (
    <section>
      <SectionHeader
        title="Members"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel={`Add ${RECORD_TARGET_TYPE_LABELS[targetType].toLowerCase()}`}
      />

      {adding && (
        <div className="mb-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <MemberPicker
              targetType={targetType}
              attached={attached}
              onPick={add}
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

      {addMember.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={addMember.error} />
        </div>
      )}
      {members.error !== null && <ErrorPanel error={members.error} />}

      {members.isLoading ? (
        <LoadingPanel label="Loading members…" />
      ) : members.records.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">No members yet.</p>
      ) : (
        <>
          <Paginator list={members} placement="top" />
          <ul className="overflow-hidden rounded-md border border-border">
            {members.records.map((member) => (
              <MemberRow key={member.id} listId={listId} member={member} />
            ))}
          </ul>
        </>
      )}

      <Paginator list={members} />
    </section>
  )
}

function MemberRow({
  listId,
  member,
}: {
  readonly listId: string
  readonly member: ListMember
}): React.JSX.Element {
  const remove = useRemoveListMember()

  return (
    <li className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to={detailPathFor(member.targetType, member.targetId)}
          className="text-left text-[13px] font-medium text-ink hover:text-accent"
        >
          {member.targetName ?? member.targetId}
        </Link>
        <button
          type="button"
          onClick={() => {
            remove.run({ listId, id: member.id })
          }}
          className="text-[11px] font-medium text-danger hover:underline"
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

/** Where a link on a member row should go. Every type has its own detail path. */
function detailPathFor(targetType: RecordTargetType, targetId: string): string {
  switch (targetType) {
    case 'person':
      return `/people/${targetId}`
    case 'company':
      return `/companies/${targetId}`
    case 'deal':
      return `/deals/${targetId}`
    case 'opportunity':
      return `/opportunities/${targetId}`
    case 'partnership':
      return `/partnerships/${targetId}`
    case 'raise':
      return `/fundraising/${targetId}`
    case 'candidate':
      // A candidate has no page of its own; the person's does.
      return `/hiring`
  }
}

/**
 * A "search or pick" combobox that queries the collection matching the list's
 * type. Each type gets its own component so React sees a stable set of hook
 * calls per render.
 */
function MemberPicker({
  targetType,
  attached,
  onPick,
}: {
  readonly targetType: RecordTargetType
  readonly attached: ReadonlySet<string>
  readonly onPick: (id: string) => void
}): React.JSX.Element {
  switch (targetType) {
    case 'person':
      return <PeoplePicker attached={attached} onPick={onPick} />
    case 'company':
      return <CompaniesPicker attached={attached} onPick={onPick} />
    case 'deal':
      return <DealsPicker attached={attached} onPick={onPick} />
    case 'opportunity':
      return <OpportunitiesPicker attached={attached} onPick={onPick} />
    case 'partnership':
      return <PartnershipsPicker attached={attached} onPick={onPick} />
    case 'raise':
      return <RaisesPicker attached={attached} onPick={onPick} />
    case 'candidate':
      return (
        <p className="text-[12px] text-ink-faint">
          Candidate lists have no inline picker in this release. Add candidacies from a role's
          page, then attach them here through the API.
        </p>
      )
  }
}

interface PickerProps {
  readonly attached: ReadonlySet<string>
  readonly onPick: (id: string) => void
}

function PeoplePicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = usePeople({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name, meta: row.email ?? undefined }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function CompaniesPicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = useCompanies({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name, meta: row.domain ?? undefined }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function DealsPicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = useDeals({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function OpportunitiesPicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = useOpportunities({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function PartnershipsPicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = usePartnerships({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function RaisesPicker({ attached, onPick }: PickerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const records = useRaises({ term: trimmedOrUndefined(search) })
  const options: readonly SearchOption[] = records.records
    .filter((row) => !attached.has(row.id))
    .map((row) => ({ id: row.id, label: row.name }))

  return <PickerBox onQueryChange={setSearch} onPick={onPick} options={options} />
}

function PickerBox({
  onQueryChange,
  onPick,
  options,
}: {
  readonly onQueryChange: (value: string) => void
  readonly onPick: (id: string) => void
  readonly options: readonly SearchOption[]
}): React.JSX.Element {
  return (
    <EntitySearch
      options={options}
      value=""
      onChange={onPick}
      onQueryChange={onQueryChange}
      placeholder="Search…"
      emptyMessage="No matches"
      size="md"
    />
  )
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : undefined
}

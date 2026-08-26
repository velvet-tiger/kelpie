import { PLAN_ITEM_STATUS_LABELS, PLAN_ITEM_STATUSES } from '@kelpie/schemas'
import type { PipelineKind, PlanItem, PlanItemStatus } from '@kelpie/schemas'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { useMembers } from '../api/resources/members.ts'
import {
  useCreatePlanItem,
  useDeletePlanItem,
  useRecordPlanItems,
  useUpdatePlanItem,
} from '../api/resources/planItems.ts'
import { formatDay } from '../lib/dates.ts'
import { planStatusTone } from '../lib/plan.ts'
import { Chip } from './Chip.tsx'
import { Paginator } from './Paginator.tsx'
import { ErrorPanel } from './QueryState.tsx'
import { SectionHeader } from './SectionHeader.tsx'

/**
 * The plan for one pipeline record: what happens next, when, and who has it.
 *
 * Ported from the mockup's panel, edit and delete included. Notes have neither,
 * because the mockup's note panel offers neither; this one offers both, so both
 * are here.
 *
 * The list arrives in date order from the API and is not re-sorted client-side:
 * `date` is the resource's default sort, so the server already answers the
 * question the panel asks.
 */

export interface PlanPanelProps {
  readonly targetType: PipelineKind
  readonly targetId: string
}

interface PlanFields {
  readonly date: string
  readonly title: string
  readonly ownerId: string
  readonly status: PlanItemStatus
}

const EMPTY_FIELDS: PlanFields = { date: '', title: '', ownerId: '', status: 'todo' }

const inputClass =
  'rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[13px] outline-none focus:border-accent'

export function PlanPanel({ targetType, targetId }: PlanPanelProps): React.JSX.Element {
  const items = useRecordPlanItems(targetType, targetId)
  const createItem = useCreatePlanItem()
  const [adding, setAdding] = useState(false)

  function submit(fields: PlanFields): void {
    createItem.run({
      targetType,
      targetId,
      date: fields.date,
      title: fields.title,
      ownerId: fields.ownerId.length === 0 ? null : fields.ownerId,
      status: fields.status,
    })
    setAdding(false)
  }

  return (
    <section>
      <SectionHeader
        title="Plan"
        onAdd={() => {
          setAdding((current) => !current)
        }}
        addLabel="Add plan item"
      />

      {createItem.error !== null && (
        <div className="mb-3">
          <ErrorPanel error={createItem.error} />
        </div>
      )}
      {items.error !== null && <ErrorPanel error={items.error} />}

      {adding && (
        <PlanItemForm
          fields={EMPTY_FIELDS}
          submitLabel="Add"
          onSubmit={submit}
          onCancel={() => {
            setAdding(false)
          }}
        />
      )}

      {items.isLoading && <p className="text-[13px] text-ink-faint">Loading plan…</p>}

      {!items.isLoading && items.records.length === 0 && !adding ? (
        <p className="text-[13px] text-ink-faint">No plan items yet.</p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-border">
          {items.records.map((item) => (
            <PlanItemRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      <Paginator list={items} />
    </section>
  )
}

function PlanItemRow({ item }: { readonly item: PlanItem }): React.JSX.Element {
  const members = useMembers()
  const updateItem = useUpdatePlanItem()
  const deleteItem = useDeletePlanItem()
  const [editing, setEditing] = useState(false)

  function save(fields: PlanFields): void {
    updateItem.run({
      id: item.id,
      changes: {
        date: fields.date,
        title: fields.title,
        ownerId: fields.ownerId.length === 0 ? null : fields.ownerId,
        status: fields.status,
      },
    })
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="border-b border-border px-4 py-3 last:border-0">
        <PlanItemForm
          fields={{
            date: item.date,
            title: item.title,
            ownerId: item.ownerId ?? '',
            status: item.status,
          }}
          submitLabel="Save"
          onSubmit={save}
          onCancel={() => {
            setEditing(false)
          }}
        />
      </li>
    )
  }

  return (
    <li className="group flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0">
      <time dateTime={item.date} className="shrink-0 text-[12px] font-medium text-ink tabular-nums">
        {formatDay(item.date)}
      </time>
      <span className="min-w-0 flex-1 text-[13px] text-ink">{item.title}</span>
      {item.ownerId !== null && (
        <span className="text-[12px] text-ink-muted">
          Owner: {members.nameById.get(item.ownerId) ?? 'Unknown'}
        </span>
      )}
      <Chip tone={planStatusTone(item.status)}>{PLAN_ITEM_STATUS_LABELS[item.status]}</Chip>
      <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={() => {
            setEditing(true)
          }}
          className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            deleteItem.run(item.id)
          }}
          className="rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-danger-soft hover:text-danger"
        >
          Delete
        </button>
      </span>
      {updateItem.error !== null && (
        <div className="w-full">
          <ErrorPanel error={updateItem.error} />
        </div>
      )}
      {deleteItem.error !== null && (
        <div className="w-full">
          <ErrorPanel error={deleteItem.error} />
        </div>
      )}
    </li>
  )
}

/**
 * The add and edit form, one component because they take the same four fields.
 *
 * `fields` seeds the draft once. The form is mounted when editing starts and
 * unmounted when it ends, so there is nothing to re-seed and no effect watching
 * a prop that is a fresh object on every render.
 *
 * The date and title inputs are `required`, so the browser refuses an empty
 * submit before the request is built. That is the same rule the API applies, not
 * a substitute for it.
 */
function PlanItemForm({
  fields,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly fields: PlanFields
  readonly submitLabel: string
  readonly onSubmit: (fields: PlanFields) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const members = useMembers()
  const [draft, setDraft] = useState(fields)

  function submit(event: FormEvent): void {
    event.preventDefault()

    const title = draft.title.trim()

    if (title.length === 0 || draft.date.length === 0) {
      return
    }

    onSubmit({ ...draft, title })
  }

  return (
    <form onSubmit={submit} className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          value={draft.date}
          onChange={(event) => {
            setDraft((current) => ({ ...current, date: event.target.value }))
          }}
          required
          aria-label="Date"
          className={inputClass}
        />
        <input
          value={draft.title}
          onChange={(event) => {
            setDraft((current) => ({ ...current, title: event.target.value }))
          }}
          placeholder="What happens…"
          required
          autoFocus
          aria-label="What happens"
          className={`min-w-[180px] flex-1 ${inputClass}`}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          value={draft.ownerId}
          onChange={(event) => {
            setDraft((current) => ({ ...current, ownerId: event.target.value }))
          }}
          aria-label="Owner"
          className={inputClass}
        >
          <option value="">Unassigned</option>
          {members.members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <select
          value={draft.status}
          onChange={(event) => {
            setDraft((current) => ({
              ...current,
              status: event.target.value as PlanItemStatus,
            }))
          }}
          aria-label="Status"
          className={inputClass}
        >
          {PLAN_ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PLAN_ITEM_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

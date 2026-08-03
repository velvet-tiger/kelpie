import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PipelineStage } from '@kelpie/schemas'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router'

import { SegmentedControl } from './SegmentedControl.tsx'

/**
 * Stage configuration for one pipeline: rename, reorder, open or closed, add,
 * remove. Ported from the mockup with one narrowing: no endpoint answers "how
 * many records sit in this stage", so removing always asks where records should
 * go instead of counting first. Moving zero records is a no-op server-side.
 */

type OpenFlag = 'open' | 'closed'

export interface StageSettingsProps {
  readonly title: string
  readonly backTo: string
  readonly backLabel: string
  /** What one record in this pipeline is called: `deal`, `opportunity`. */
  readonly recordNoun: string
  readonly stages: readonly PipelineStage[]
  readonly onRename: (id: string, label: string) => void
  readonly onReorder: (activeId: string, overId: string) => void
  readonly onToggleOpen: (id: string, open: boolean) => void
  readonly onAdd: (label: string) => void
  readonly onRemove: (id: string, moveToId: string) => void
}

export function StageSettings({
  title,
  backTo,
  backLabel,
  recordNoun,
  stages,
  onRename,
  onReorder,
  onToggleOpen,
  onAdd,
  onRemove,
}: StageSettingsProps): React.JSX.Element {
  const [newLabel, setNewLabel] = useState('')
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [moveToId, setMoveToId] = useState('')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event

    if (over === null) {
      return
    }

    const activeId = String(active.id)
    const overId = String(over.id)

    if (activeId !== overId) {
      onReorder(activeId, overId)
    }
  }

  function requestRemove(id: string): void {
    if (stages.length <= 1) {
      return
    }

    setMoveToId(stages.find((stage) => stage.id !== id)?.id ?? '')
    setPendingRemoveId(id)
  }

  function confirmRemove(): void {
    if (pendingRemoveId === null || moveToId.length === 0) {
      return
    }

    onRemove(pendingRemoveId, moveToId)
    setPendingRemoveId(null)
    setMoveToId('')
  }

  function handleAdd(event: FormEvent): void {
    event.preventDefault()

    const trimmed = newLabel.trim()

    if (trimmed.length === 0) {
      return
    }

    onAdd(trimmed)
    setNewLabel('')
  }

  const pendingStage = stages.find((stage) => stage.id === pendingRemoveId)
  const moveTargets = stages.filter((stage) => stage.id !== pendingRemoveId)

  return (
    <div className="animate-fade-in mx-auto max-w-xl">
      <Link
        to={backTo}
        className="mb-4 inline-flex text-[12px] font-medium text-ink-muted hover:text-ink"
      >
        ← {backLabel}
      </Link>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-1 text-[13px] text-ink-muted">
        Add, rename, reorder, or remove stages. Renaming only changes the label. Closed stages are
        hidden when the board is set to Open.
      </p>

      <div className="mt-6 rounded-md border border-border">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={stages.map((stage) => stage.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="divide-y divide-border">
              {stages.map((stage) => (
                <SortableStageRow
                  key={stage.id}
                  stage={stage}
                  canRemove={stages.length > 1}
                  onRename={(label) => {
                    onRename(stage.id, label)
                  }}
                  onToggleOpen={(open) => {
                    onToggleOpen(stage.id, open)
                  }}
                  onRemove={() => {
                    requestRemove(stage.id)
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>

      <form onSubmit={handleAdd} className="mt-4 flex gap-2">
        <input
          value={newLabel}
          onChange={(event) => {
            setNewLabel(event.target.value)
          }}
          placeholder="New stage name"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <button
          type="submit"
          disabled={newLabel.trim().length === 0}
          className="rounded-md bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          Add stage
        </button>
      </form>

      {pendingStage !== undefined && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="animate-slide-in w-full max-w-md rounded-md border border-border bg-surface-raised p-5">
            <h2 className="text-[15px] font-semibold text-ink">
              Remove “{pendingStage.label}”?
            </h2>
            <p className="mt-1 text-[12px] text-ink-muted">
              Any {recordNoun}s still in this stage will move to the stage you pick.
            </p>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-[12px] font-medium">Move to</span>
              <select
                value={moveToId}
                onChange={(event) => {
                  setMoveToId(event.target.value)
                }}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              >
                {moveTargets.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPendingRemoveId(null)
                  setMoveToId('')
                }}
                className="rounded-md px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRemove}
                disabled={moveToId.length === 0}
                className="rounded-md bg-danger px-3.5 py-2 text-[12px] font-medium text-danger-fg hover:opacity-90 disabled:opacity-40"
              >
                Move and remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SortableStageRow({
  stage,
  canRemove,
  onRename,
  onToggleOpen,
  onRemove,
}: {
  readonly stage: PipelineStage
  readonly canRemove: boolean
  readonly onRename: (label: string) => void
  readonly onToggleOpen: (open: boolean) => void
  readonly onRemove: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
  })

  const [draft, setDraft] = useState(stage.label)

  useEffect(() => {
    setDraft(stage.label)
  }, [stage.label])

  function commitRename(): void {
    const trimmed = draft.trim()

    if (trimmed.length === 0) {
      setDraft(stage.label)

      return
    }

    if (trimmed !== stage.label) {
      onRename(trimmed)
    }

    setDraft(trimmed)
  }

  const openValue: OpenFlag = stage.open ? 'open' : 'closed'

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="flex flex-wrap items-center gap-3 px-3 py-3"
    >
      <button
        type="button"
        className="cursor-grab touch-none px-1 py-1 text-[11px] text-ink-faint active:cursor-grabbing"
        aria-label={`Drag to reorder ${stage.label}`}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="min-w-0 flex-1">
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              ;(event.target as HTMLInputElement).blur()
            }

            if (event.key === 'Escape') {
              setDraft(stage.label)
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium text-ink outline-none hover:border-border focus:border-accent focus:ring-2 focus:ring-accent/20"
          aria-label={`Stage name for ${stage.label}`}
        />
        <div className="mt-0.5 px-2 font-mono text-[11px] text-ink-faint">{stage.slug}</div>
      </div>
      <SegmentedControl
        ariaLabel={`Open or closed for ${stage.label}`}
        value={openValue}
        onChange={(value) => {
          onToggleOpen(value === 'open')
        }}
        options={[
          { id: 'open', label: 'Open' },
          { id: 'closed', label: 'Closed' },
        ]}
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        Remove
      </button>
    </li>
  )
}

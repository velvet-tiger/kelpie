import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

/**
 * The pipeline board, ported from the mockup: one droppable column per stage,
 * draggable cards, and an overlay following the pointer. Dropping a card calls
 * `onMove`; what that persists is the page's business.
 */

export interface KanbanStage {
  readonly id: string
  readonly label: string
}

export interface KanbanCard {
  readonly id: string
  readonly stage: string
  readonly title: string
  readonly meta?: string
  readonly valueLabel?: string
  readonly href: string
}

export interface KanbanBoardProps {
  readonly stages: readonly KanbanStage[]
  readonly cards: readonly KanbanCard[]
  readonly onMove: (cardId: string, stageId: string) => void
}

function isStageDropData(data: unknown): data is { type: string; stageId: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'stageId' in data &&
    typeof (data as { stageId: unknown }).stageId === 'string'
  )
}

export function KanbanBoard({ stages, cards, onMove }: KanbanBoardProps): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const activeCard = cards.find((card) => card.id === activeId) ?? null

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null)

    const { active, over } = event

    if (over === null) {
      return
    }

    const cardId = String(active.id)
    const overData: unknown = over.data.current

    if (isStageDropData(overData)) {
      onMove(cardId, overData.stageId)

      return
    }

    const overId = String(over.id)
    const overStage = stages.find((stage) => stage.id === overId)

    if (overStage !== undefined) {
      onMove(cardId, overStage.id)

      return
    }

    const overCard = cards.find((card) => card.id === overId)

    if (overCard !== undefined) {
      onMove(cardId, overCard.stage)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const stageCards = cards.filter((card) => card.stage === stage.id)

          return (
            <KanbanColumn key={stage.id} stage={stage} count={stageCards.length}>
              {stageCards.map((card) => (
                <KanbanCardView key={card.id} card={card} dragging={card.id === activeId} />
              ))}
            </KanbanColumn>
          )
        })}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeCard === null ? null : (
          <div className="cursor-grabbing rounded-md border border-accent bg-surface-raised">
            <CardFace card={activeCard} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function KanbanColumn({
  stage,
  count,
  children,
}: {
  readonly stage: KanbanStage
  readonly count: number
  readonly children: ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: stage.id,
    data: { type: 'stage', stageId: stage.id },
  })

  return (
    <div
      ref={setNodeRef}
      className={[
        'flex w-[240px] shrink-0 flex-col rounded-md border bg-surface-sunken/40 transition-colors',
        isOver ? 'border-accent bg-accent-soft/30' : 'border-border',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-[12px] font-semibold text-ink">{stage.label}</h3>
        <span className="font-mono text-[11px] text-ink-faint">{count}</span>
      </div>
      <div className="flex min-h-[80px] flex-col gap-2 px-2 pb-2">
        {children}
        {count === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-ink-faint">
            Drop here
          </div>
        )}
      </div>
    </div>
  )
}

function KanbanCardView({
  card,
  dragging,
}: {
  readonly card: KanbanCard
  readonly dragging: boolean
}): React.JSX.Element {
  const navigate = useNavigate()
  const suppressClick = useRef(false)
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: card.id,
    data: { type: 'card', stageId: card.stage },
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop:${card.id}`,
    data: { type: 'card', stageId: card.stage },
  })

  useEffect(() => {
    if (isDragging || dragging) {
      suppressClick.current = true
    }
  }, [isDragging, dragging])

  return (
    <div
      ref={(node) => {
        setDragRef(node)
        setDropRef(node)
      }}
      {...listeners}
      {...attributes}
      onClick={() => {
        // A drag ends where it started often enough that the click after a drop
        // would open the card someone was only moving.
        if (suppressClick.current) {
          suppressClick.current = false

          return
        }

        void navigate(card.href)
      }}
      className={[
        'cursor-grab touch-none rounded-md border bg-surface-raised transition-colors active:cursor-grabbing',
        isOver ? 'border-accent' : 'border-border',
        dragging || isDragging ? 'opacity-40' : 'hover:border-border-strong',
      ].join(' ')}
    >
      <CardFace card={card} />
    </div>
  )
}

function CardFace({ card }: { readonly card: KanbanCard }): React.JSX.Element {
  return (
    <div className="px-3 py-2.5">
      <div className="text-[13px] font-medium leading-snug text-ink">{card.title}</div>
      {card.meta !== undefined && <div className="mt-1 text-[11px] text-ink-muted">{card.meta}</div>}
      {card.valueLabel !== undefined && (
        <div className="mt-2 font-mono text-[12px] font-medium text-ink">{card.valueLabel}</div>
      )}
    </div>
  )
}

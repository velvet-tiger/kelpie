import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { HandbookPage } from '@kelpie/schemas'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useTimezone } from '../../api/resources/account.ts'
import {
  useCreateHandbookPage,
  useDeleteHandbookPage,
  useHandbookPages,
  useUpdateHandbookPage,
} from '../../api/resources/handbookPages.ts'
import { useMembers } from '../../api/resources/members.ts'
import { AgentTasks } from '../../components/AgentTasks.tsx'
import { MarkdownView } from '../../components/MarkdownView.tsx'
import { ErrorPanel, LoadingPanel } from '../../components/QueryState.tsx'
import { formatDateTime } from '../../lib/dates.ts'
import { INDENT, descendantIds, flattenTree, landingMoves, projectDrop } from './tree.ts'
import type { FlatItem } from './tree.ts'

/**
 * The handbook: a draggable tree of pages beside the one being read.
 *
 * Ported from the mockup, where the tree was local state and every edit was lost
 * on navigation. The shapes are the same; what changed is where they live. A
 * drop sends one PATCH naming the new parent and position, and the server
 * renumbers both sibling sets, so the page never computes a `sort_order` for
 * anything it did not drag.
 */

const NEW_PAGE_TITLE = 'Untitled page'

export function HandbookLayout(): React.JSX.Element {
  const { pageId } = useParams()
  const navigate = useNavigate()
  const pages = useHandbookPages()
  const members = useMembers()
  const createPage = useCreateHandbookPage()
  const updatePage = useUpdateHandbookPage()
  const deletePage = useDeleteHandbookPage()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [offsetX, setOffsetX] = useState(0)

  const flat = useMemo(() => flattenTree(pages.records), [pages.records])
  const active = pages.records.find((page) => page.id === (pageId ?? flat[0]?.id))
  const dragging = flat.find((item) => item.id === activeId)

  const liveDepth =
    activeId !== null && overId !== null
      ? projectDrop(flat, pages.records, activeId, overId, offsetX).depth
      : dragging?.depth

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => {
    const first = flat[0]

    if (pageId === undefined && first !== undefined) {
      void navigate(`/handbook/${first.id}`, { replace: true })
    }
  }, [pageId, flat, navigate])

  async function addPage(parentId: string | null): Promise<void> {
    const page = await createPage.runAsync({
      title: NEW_PAGE_TITLE,
      body: `# ${NEW_PAGE_TITLE}\n\nStart writing…\n`,
      parentId,
    })

    await navigate(`/handbook/${page.id}`)
  }

  /**
   * Deletes a page and everything under it, after saying how much that is.
   *
   * The count comes from the tree already on screen. It is the same cascade the
   * API performs, named before it happens rather than reported after.
   */
  async function removePage(page: HandbookPage): Promise<void> {
    const nested = descendantIds(pages.records, page.id).size
    const confirmed = window.confirm(
      nested > 0
        ? `Delete this page and ${String(nested)} nested page${nested > 1 ? 's' : ''}?`
        : 'Delete this page?',
    )

    if (!confirmed) {
      return
    }

    const doomed = new Set([page.id, ...descendantIds(pages.records, page.id)])

    await deletePage.runAsync(page.id)

    if (pageId !== undefined && doomed.has(pageId)) {
      const fallback = flat.find((item) => !doomed.has(item.id))

      await navigate(fallback === undefined ? '/handbook' : `/handbook/${fallback.id}`)
    }
  }

  function clearDrag(): void {
    setActiveId(null)
    setOverId(null)
    setOffsetX(0)
  }

  function onDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id))
    setOverId(String(event.active.id))
    setOffsetX(0)
  }

  function onDragMove(event: DragMoveEvent): void {
    setOffsetX(event.delta.x)

    if (event.over !== null) {
      setOverId(String(event.over.id))
    }
  }

  /**
   * A drop is projected even when it landed on the row it started from.
   *
   * The mockup bailed on that case, which made an indent-in-place impossible:
   * dragging a page straight left to lift it out of its parent did nothing,
   * because with no vertical movement the nearest row is the dragged one. What
   * decides whether to write is whether the landing differs from where the page
   * already is, not which row the pointer happened to finish over.
   */
  function onDragEnd(event: DragEndEvent): void {
    const dragId = activeId
    const dropId = event.over === null ? null : String(event.over.id)
    const movedBy = offsetX

    clearDrag()

    if (dragId === null || dropId === null) {
      return
    }

    const landing = projectDrop(flat, pages.records, dragId, dropId, movedBy)

    if (!landingMoves(pages.records, dragId, landing)) {
      return
    }

    updatePage.run({
      id: dragId,
      changes: { parentId: landing.parentId, sortOrder: landing.insertIndex },
    })
  }

  if (pages.isLoading) {
    return <LoadingPanel label="Loading the handbook…" />
  }

  if (pages.error !== null) {
    return <ErrorPanel error={pages.error} />
  }

  return (
    <div className="animate-fade-in flex min-h-[calc(100vh-8rem)] gap-0 overflow-hidden rounded-md border border-border">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <div>
            <div className="text-[13px] font-semibold text-ink">Handbook</div>
            <div className="text-[11px] text-ink-faint">Drag to reorder · indent to nest</div>
          </div>
          <button
            type="button"
            disabled={createPage.isPending}
            onClick={() => {
              void addPage(null)
            }}
            className="rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
          >
            New
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            onDragEnd={onDragEnd}
            onDragCancel={clearDrag}
          >
            <SortableContext
              items={flat.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-0.5">
                {flat.map((item) => (
                  <SortableTreeItem
                    key={item.id}
                    item={item}
                    depth={item.id === activeId && liveDepth !== undefined ? liveDepth : item.depth}
                    selected={item.id === active?.id}
                    onAddChild={() => {
                      void addPage(item.id)
                    }}
                    onDelete={() => {
                      void removePage(item.page)
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
            <DragOverlay dropAnimation={null}>
              {dragging === undefined ? null : (
                <div
                  className="rounded-md border border-accent bg-surface-raised px-2.5 py-1.5 text-[13px] font-medium text-ink"
                  style={{ marginLeft: (liveDepth ?? dragging.depth) * INDENT }}
                >
                  {dragging.page.title}
                </div>
              )}
            </DragOverlay>
          </DndContext>
          {flat.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-ink-faint">No pages yet.</p>
          )}
          {pages.hasMore && (
            <p className="px-2 py-3 text-center text-[11px] text-ink-faint">
              This handbook has more pages than one request returns, so the tree below is
              incomplete.
            </p>
          )}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        {active === undefined ? (
          <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">
            No handbook pages yet.
          </div>
        ) : (
          <HandbookEditor
            key={active.id}
            page={active}
            authorName={
              active.updatedBy === null ? undefined : members.nameById.get(active.updatedBy)
            }
            isSaving={updatePage.isPending}
            error={updatePage.error ?? deletePage.error}
            onSave={(changes) => {
              updatePage.run({ id: active.id, changes })
            }}
            onAddChild={() => {
              void addPage(active.id)
            }}
            onDelete={() => {
              void removePage(active)
            }}
          />
        )}
      </div>
    </div>
  )
}

interface SortableTreeItemProps {
  readonly item: FlatItem
  readonly depth: number
  readonly selected: boolean
  readonly onAddChild: () => void
  readonly onDelete: () => void
}

function SortableTreeItem({
  item,
  depth,
  selected,
  onAddChild,
  onDelete,
}: SortableTreeItemProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        marginLeft: depth * INDENT,
        opacity: isDragging ? 0.35 : 1,
      }}
      className="group relative"
    >
      <div
        className={[
          'flex items-center gap-0.5 rounded-md pr-1 transition-colors',
          selected
            ? 'bg-accent-soft text-accent-hover'
            : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
        ].join(' ')}
      >
        <button
          type="button"
          className="cursor-grab touch-none px-1 py-1.5 text-[10px] text-ink-faint active:cursor-grabbing"
          aria-label={`Drag ${item.page.title} to reorder`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <Link
          to={`/handbook/${item.id}`}
          className={[
            'min-w-0 flex-1 truncate py-1.5 pr-1 text-[13px]',
            selected ? 'font-medium' : '',
          ].join(' ')}
        >
          {item.page.title}
        </Link>
        <button
          type="button"
          title="Add subpage"
          onClick={(event) => {
            event.preventDefault()
            onAddChild()
          }}
          className="hidden rounded px-1 py-0.5 text-[12px] font-medium text-ink-faint group-hover:inline hover:bg-surface hover:text-accent"
        >
          +
        </button>
        <button
          type="button"
          title="Delete"
          onClick={(event) => {
            event.preventDefault()
            onDelete()
          }}
          className="hidden rounded px-1 py-0.5 text-[11px] font-medium text-ink-faint group-hover:inline hover:bg-danger-soft hover:text-danger"
        >
          ×
        </button>
      </div>
    </li>
  )
}

interface HandbookEditorProps {
  readonly page: HandbookPage
  readonly authorName: string | undefined
  readonly isSaving: boolean
  readonly error: Error | null
  readonly onSave: (changes: { readonly title: string; readonly body: string }) => void
  readonly onAddChild: () => void
  readonly onDelete: () => void
}

/**
 * One page: read as rendered markdown, edited as its source.
 *
 * A rename sends the title and nothing else about the address. The slug is the
 * handle agent tasks name a page by, so the API leaves it where it is unless it
 * is set on purpose, and this editor never sets it.
 */
function HandbookEditor({
  page,
  authorName,
  isSaving,
  error,
  onSave,
  onAddChild,
  onDelete,
}: HandbookEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(page.title)
  const [body, setBody] = useState(page.body)
  const timezone = useTimezone()

  useEffect(() => {
    setTitle(page.title)
    setBody(page.body)
    setEditing(false)
  }, [page.id, page.title, page.body])

  function save(): void {
    const trimmed = title.trim()

    onSave({ title: trimmed.length === 0 ? NEW_PAGE_TITLE : trimmed, body })
    setEditing(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={title}
              aria-label="Page title"
              onChange={(event) => {
                setTitle(event.target.value)
              }}
              className="w-full min-w-[200px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-[15px] font-semibold outline-none focus:border-accent"
            />
          ) : (
            <h1 className="text-[18px] font-semibold tracking-tight text-ink">{page.title}</h1>
          )}
          <div className="mt-1 text-[11px] text-ink-faint">
            Updated {formatDateTime(page.updatedAt, timezone)}
            {authorName === undefined ? '' : ` · ${authorName}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setTitle(page.title)
                  setBody(page.body)
                  setEditing(false)
                }}
                className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={save}
                className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
            </>
          ) : (
            <>
              <AgentTasks targetType="handbook" targetId={page.id} targetLabel={page.title} />
              <button
                type="button"
                onClick={onAddChild}
                className="rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-ink-muted transition hover:border-accent hover:text-accent-hover"
              >
                Add subpage
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-md border border-border px-2.5 py-1.5 text-[12px] font-medium text-danger transition hover:border-danger hover:bg-danger-soft"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(true)
                }}
                className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-ink transition hover:border-accent hover:text-accent-hover"
              >
                Edit
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {error !== null && (
          <div className="mb-4 max-w-3xl">
            <ErrorPanel error={error} />
          </div>
        )}
        {editing ? (
          <textarea
            value={body}
            aria-label="Page body"
            onChange={(event) => {
              setBody(event.target.value)
            }}
            className="min-h-[480px] w-full resize-y rounded-md border border-border bg-surface p-4 font-mono text-[13px] leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            spellCheck
          />
        ) : (
          <div className="animate-slide-in max-w-3xl">
            <MarkdownView source={page.body} />
          </div>
        )}
      </div>
    </div>
  )
}

import { MAX_HANDBOOK_DEPTH } from '@kelpie/schemas'
import type { HandbookPage } from '@kelpie/schemas'

/**
 * The sidebar tree: how a flat list of pages becomes an indented list, and where
 * a drag would put the page being dragged.
 *
 * Ported from the mockup's `HandbookPage.tsx`, extracted into its own module
 * because the projection is the only genuinely intricate part of the page and it
 * is pure: flat list in, landing spot out. The page turns that landing spot into
 * one PATCH and lets the server renumber the siblings.
 */

/** Pixels of indent per level. The drag reads horizontal movement in these units. */
export const INDENT = 14

export interface FlatItem {
  readonly id: string
  readonly page: HandbookPage
  readonly depth: number
}

/** Where a dragged page would land: a new parent, and a position among that parent's children. */
export interface Projection {
  readonly parentId: string | null
  readonly depth: number
  readonly insertIndex: number
}

/**
 * One parent's children, in sidebar order.
 *
 * Title breaks a tie, which the mockup did and the API makes unnecessary: the
 * server keeps a sibling set contiguous from 0. It stays because the tie is
 * real for the moment an optimistic update holds two pages at one position.
 */
export function childrenOf(
  pages: readonly HandbookPage[],
  parentId: string | null,
): HandbookPage[] {
  return pages
    .filter((page) => page.parentId === parentId)
    .sort(
      (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title),
    )
}

/**
 * The tree as the list of rows the sidebar renders, parents before their children.
 *
 * A page whose parent is missing is left out. That happens for the moment
 * between deleting a page and the list refetching, and floating its orphaned
 * subpages to the top level would read as though somebody had moved them there.
 */
export function flattenTree(pages: readonly HandbookPage[]): FlatItem[] {
  const rows: FlatItem[] = []

  function walk(parentId: string | null, depth: number): void {
    for (const page of childrenOf(pages, parentId)) {
      rows.push({ id: page.id, page, depth })
      walk(page.id, depth + 1)
    }
  }

  walk(null, 0)

  return rows
}

/** Every page under this one, at any depth: the subtree a delete takes and a drag may not enter. */
export function descendantIds(pages: readonly HandbookPage[], rootId: string): Set<string> {
  const found = new Set<string>()

  function walk(parentId: string): void {
    for (const child of childrenOf(pages, parentId)) {
      found.add(child.id)
      walk(child.id)
    }
  }

  walk(rootId)

  return found
}

/**
 * The nearest row above and below the drop target, skipping the page being
 * dragged and everything under it.
 *
 * Those rows are what bound the depth: a page can be at most one level deeper
 * than the row above it, and no shallower than the row below, or it would adopt
 * that row's subtree by sitting above it at a lower indent.
 */
function neighbours(
  flat: readonly FlatItem[],
  activeIndex: number,
  overIndex: number,
  skip: ReadonlySet<string>,
): { previous: FlatItem | undefined; next: FlatItem | undefined } {
  const passes = (item: FlatItem): boolean => !skip.has(item.id)
  const movingDown = activeIndex < overIndex

  let previous: FlatItem | undefined
  let next: FlatItem | undefined

  for (let index = overIndex - (movingDown ? 0 : 1); index >= 0; index -= 1) {
    const item = flat[index]

    if (item !== undefined && passes(item)) {
      previous = item
      break
    }
  }

  for (let index = overIndex + (movingDown ? 1 : 0); index < flat.length; index += 1) {
    const item = flat[index]

    if (item !== undefined && passes(item)) {
      next = item
      break
    }
  }

  return { previous, next }
}

/** The parent a page sits under at `depth`, given the row above it. */
function parentAtDepth(
  flat: readonly FlatItem[],
  pages: readonly HandbookPage[],
  previous: FlatItem,
  depth: number,
): string | null {
  if (depth === previous.depth) {
    return previous.page.parentId
  }

  if (depth > previous.depth) {
    return previous.id
  }

  // Shallower than the row above: walk up its ancestors to the one that sits at
  // the level being dropped into.
  let cursor: HandbookPage | undefined = previous.page

  while (cursor !== undefined) {
    const row = flat.find((item) => item.id === cursor?.id)

    if (row !== undefined && row.depth === depth - 1) {
      return cursor.id
    }

    if (row !== undefined && row.depth < depth) {
      return cursor.parentId
    }

    cursor =
      cursor.parentId === null
        ? undefined
        : pages.find((page) => page.id === cursor?.parentId)
  }

  return null
}

/**
 * Where a drag would land the page.
 *
 * @param offsetX How far the pointer has moved horizontally. Divided by `INDENT`
 *   it is the change in nesting depth, which is how one gesture reorders and
 *   re-nests at once.
 * @returns The landing spot, clamped to a legal one. A drop onto the page's own
 *   subtree, or past the depth cap, resolves to where the page already is rather
 *   than to a request the server would refuse.
 */
export function projectDrop(
  flat: readonly FlatItem[],
  pages: readonly HandbookPage[],
  activeId: string,
  overId: string,
  offsetX: number,
): Projection {
  const active = flat.find((item) => item.id === activeId)
  const over = flat.find((item) => item.id === overId)

  if (active === undefined || over === undefined) {
    return { parentId: null, depth: 0, insertIndex: 0 }
  }

  const doomed = descendantIds(pages, activeId)
  const skip = new Set([activeId, ...doomed])
  const activeIndex = flat.findIndex((item) => item.id === activeId)
  const overIndex = flat.findIndex((item) => item.id === overId)
  const { previous, next } = neighbours(flat, activeIndex, overIndex, skip)

  const requested = Math.round((active.depth * INDENT + offsetX) / INDENT)
  const ceiling = previous === undefined ? 0 : Math.min(MAX_HANDBOOK_DEPTH, previous.depth + 1)
  const floor = next?.depth ?? 0
  const depth = Math.max(floor, Math.min(ceiling, Math.max(0, requested)))

  const proposed =
    depth === 0 || previous === undefined ? null : parentAtDepth(flat, pages, previous, depth)
  // A projection can still name the page itself or one of its own subpages.
  // Leaving it where it is beats sending a move the API would answer 422 to.
  const refused = proposed === activeId || (proposed !== null && doomed.has(proposed))
  const parentId = refused ? active.page.parentId : proposed

  const siblings = childrenOf(pages, parentId).filter((page) => page.id !== activeId)

  return {
    parentId,
    depth: refused ? active.depth : depth,
    insertIndex: insertionFor(siblings, {
      pages,
      activeId,
      over,
      previous,
      parentId,
      activeIndex,
      overIndex,
    }),
  }
}

interface InsertionContext {
  readonly pages: readonly HandbookPage[]
  readonly activeId: string
  readonly over: FlatItem
  readonly previous: FlatItem | undefined
  readonly parentId: string | null
  readonly activeIndex: number
  readonly overIndex: number
}

/**
 * The row above the drop, or whichever of its ancestors is a child of `parentId`.
 *
 * The row immediately above is often deeper than where the page is landing: drop
 * a top-level page below a nested one and the nearest row is a grandchild of the
 * sibling it should follow. Walking up finds the sibling it can actually be
 * measured against.
 */
function landmarkUnder(
  pages: readonly HandbookPage[],
  from: HandbookPage,
  parentId: string | null,
): string | undefined {
  let cursor: HandbookPage | undefined = from

  while (cursor !== undefined) {
    if (cursor.parentId === parentId) {
      return cursor.id
    }

    const above: string | null = cursor.parentId

    cursor = above === null ? undefined : pages.find((page) => page.id === above)
  }

  return undefined
}

/** The position among the new siblings, 0-based, which is what `sort_order` means to the API. */
function insertionFor(siblings: readonly HandbookPage[], context: InsertionContext): number {
  const { pages, activeId, over, previous, parentId, activeIndex, overIndex } = context

  // Dropped onto the page that is becoming the parent, or dropped straight below
  // it: either way the page lands as its first child.
  if (over.id === parentId || previous?.id === parentId) {
    return 0
  }

  // A drop onto the dragged row itself is an indent in place. The row dropped on
  // is the one moving, so it cannot also be the landmark; `siblings` has it
  // filtered out and asking it for a position would answer "the end".
  if (over.id !== activeId && over.page.parentId === parentId) {
    const index = siblings.findIndex((page) => page.id === over.id)

    if (index < 0) {
      return siblings.length
    }

    // Dragging down lands after the row dropped on; dragging up lands before it.
    return activeIndex < overIndex ? index + 1 : index
  }

  if (previous === undefined) {
    // Nothing above it in the list, so there is nowhere to land but the top.
    return 0
  }

  const landmark = landmarkUnder(pages, previous.page, parentId)
  const index = landmark === undefined ? -1 : siblings.findIndex((page) => page.id === landmark)

  return index < 0 ? siblings.length : index + 1
}

/**
 * Whether a landing actually moves the page.
 *
 * Every activated drag ends somewhere, including one that ended where it
 * started. Without this a nudge past the 6px activation distance would send a
 * PATCH, and the optimistic cache write behind it would make the sidebar jump
 * for a gesture that asked for nothing.
 */
export function landingMoves(
  pages: readonly HandbookPage[],
  pageId: string,
  landing: Projection,
): boolean {
  const page = pages.find((candidate) => candidate.id === pageId)

  if (page === undefined) {
    return false
  }

  if (page.parentId !== landing.parentId) {
    return true
  }

  // `insertIndex` counts a sibling set the page has been lifted out of, so the
  // page's own current index is the position that means "put it back".
  return (
    childrenOf(pages, page.parentId).findIndex((sibling) => sibling.id === pageId) !==
    landing.insertIndex
  )
}

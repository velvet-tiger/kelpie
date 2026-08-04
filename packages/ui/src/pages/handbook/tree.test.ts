import type { HandbookPage } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { INDENT, childrenOf, descendantIds, flattenTree, landingMoves, projectDrop } from './tree.ts'

/**
 * Where a drag lands.
 *
 * This is the one part of the handbook page that is hard to read and easy to get
 * wrong, and it is pure, so it gets a test rather than a careful look. The API
 * refuses an illegal move regardless; these cases are about the sidebar not
 * asking for one in the first place.
 */

function page(id: string, parentId: string | null, sortOrder: number): HandbookPage {
  return {
    id,
    title: id,
    slug: id,
    parentId,
    sortOrder,
    body: '',
    updatedBy: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  }
}

/**
 *   about
 *     product
 *       roadmap
 *   pricing
 *   voice
 */
const pages: readonly HandbookPage[] = [
  page('about', null, 0),
  page('product', 'about', 0),
  page('roadmap', 'product', 0),
  page('pricing', null, 1),
  page('voice', null, 2),
]

const flat = flattenTree(pages)

/** The horizontal drag that asks for a given depth, starting from the row's own. */
function toDepth(from: number, to: number): number {
  return (to - from) * INDENT
}

describe('childrenOf', () => {
  it('orders siblings by position', () => {
    expect(childrenOf(pages, null).map((item) => item.id)).toEqual(['about', 'pricing', 'voice'])
  })

  it('breaks a shared position by title, for the moment an optimistic move holds two', () => {
    const tied = [page('zebra', null, 0), page('alpha', null, 0)]

    expect(childrenOf(tied, null).map((item) => item.id)).toEqual(['alpha', 'zebra'])
  })
})

describe('flattenTree', () => {
  it('lists parents before their children, with a depth each', () => {
    expect(flat.map((item) => [item.id, item.depth])).toEqual([
      ['about', 0],
      ['product', 1],
      ['roadmap', 2],
      ['pricing', 0],
      ['voice', 0],
    ])
  })

  it('leaves out a page whose parent is gone rather than floating it to the top', () => {
    const orphaned = pages.filter((item) => item.id !== 'product')

    expect(flattenTree(orphaned).map((item) => item.id)).toEqual(['about', 'pricing', 'voice'])
  })
})

describe('descendantIds', () => {
  it('collects the subtree a delete would take', () => {
    expect([...descendantIds(pages, 'about')].sort()).toEqual(['product', 'roadmap'])
  })
})

describe('projectDrop', () => {
  it('reorders within the top level when the pointer does not move sideways', () => {
    const landing = projectDrop(flat, pages, 'voice', 'pricing', 0)

    expect(landing.parentId).toBeNull()
    expect(landing.depth).toBe(0)
    expect(landing.insertIndex).toBe(1)
  })

  it('nests under the row it was dragged past when the pointer moves right', () => {
    const landing = projectDrop(flat, pages, 'pricing', 'voice', toDepth(0, 1))

    expect(landing.parentId).toBe('voice')
    expect(landing.depth).toBe(1)
  })

  it('will not indent more than one level past the row above the drop', () => {
    const landing = projectDrop(flat, pages, 'pricing', 'voice', toDepth(0, 4))

    expect(landing.depth).toBe(1)
    expect(landing.parentId).toBe('voice')
  })

  /**
   * Dragging up onto a row lands above it, so the new siblings are that row's,
   * not that row's children. Nesting under it is the downward gesture above.
   */
  it('lands above the row a drag was pulled up onto', () => {
    const landing = projectDrop(flat, pages, 'pricing', 'roadmap', toDepth(0, 3))

    expect(landing.parentId).toBe('product')
    expect(landing.depth).toBe(2)
    expect(landing.insertIndex).toBe(0)
  })

  it('lifts a page to the top level when the pointer moves left', () => {
    const landing = projectDrop(flat, pages, 'roadmap', 'voice', toDepth(2, 0))

    expect(landing.parentId).toBeNull()
    expect(landing.depth).toBe(0)
  })

  it('leaves a page where it is rather than dropping it into its own subtree', () => {
    const landing = projectDrop(flat, pages, 'about', 'roadmap', toDepth(0, 3))

    expect(landing.parentId).toBeNull()
    expect(landing.depth).toBe(0)
  })

  it('caps the depth a drag can ask for, whatever the pointer says', () => {
    const deep = [
      page('a', null, 0),
      page('b', 'a', 0),
      page('c', 'b', 0),
      page('d', 'c', 0),
      page('e', 'd', 0),
      page('loose', null, 1),
    ]
    const landing = projectDrop(flattenTree(deep), deep, 'loose', 'e', toDepth(0, 9))

    expect(landing.depth).toBe(4)
    expect(landing.parentId).toBe('d')
  })

  it('answers the top of the top level for a drag whose rows are no longer on screen', () => {
    expect(projectDrop(flat, pages, 'gone', 'pricing', 0)).toEqual({
      parentId: null,
      depth: 0,
      insertIndex: 0,
    })
  })
})

/**
 * A drag straight sideways never leaves the row it started on, so `over` is the
 * dragged row itself. That is the whole gesture for indenting a page in place,
 * and it has to be projected rather than discarded.
 */
describe('projectDrop onto the dragged row itself', () => {
  it('lifts a page out of its parent when the pointer moves left', () => {
    const landing = projectDrop(flat, pages, 'product', 'product', toDepth(1, 0))

    expect(landing.parentId).toBeNull()
    expect(landing.depth).toBe(0)
    // Straight after the parent it just left, where the reader last saw it.
    expect(landing.insertIndex).toBe(1)
  })

  it('nests a page under the row above it when the pointer moves right', () => {
    const landing = projectDrop(flat, pages, 'pricing', 'pricing', toDepth(0, 1))

    expect(landing.parentId).toBe('about')
    expect(landing.depth).toBe(1)
  })

  it('does not relocate a page dropped back where it started', () => {
    for (const id of ['about', 'product', 'roadmap', 'pricing', 'voice']) {
      const landing = projectDrop(flat, pages, id, id, 0)

      expect({ id, ...landing }).toEqual({
        id,
        parentId: pages.find((page) => page.id === id)?.parentId ?? null,
        depth: flat.find((item) => item.id === id)?.depth,
        insertIndex: childrenOf(pages, pages.find((page) => page.id === id)?.parentId ?? null)
          .findIndex((sibling) => sibling.id === id),
      })
    }
  })
})

describe('landingMoves', () => {
  it('is false for every page dropped back where it started', () => {
    for (const id of ['about', 'product', 'roadmap', 'pricing', 'voice']) {
      expect(landingMoves(pages, id, projectDrop(flat, pages, id, id, 0))).toBe(false)
    }
  })

  it('is true when the page changes parent', () => {
    expect(landingMoves(pages, 'product', projectDrop(flat, pages, 'product', 'product', toDepth(1, 0)))).toBe(true)
  })

  it('is true when the page keeps its parent but changes position', () => {
    expect(landingMoves(pages, 'voice', projectDrop(flat, pages, 'voice', 'pricing', 0))).toBe(true)
  })

  it('is false for a page that is no longer in the list', () => {
    expect(landingMoves(pages, 'gone', { parentId: null, depth: 0, insertIndex: 0 })).toBe(false)
  })
})

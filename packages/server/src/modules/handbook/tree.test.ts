import { describe, expect, it } from 'vitest'

import { MAX_DEPTH, childrenOf, depthOf, descendantIds, placeAt, rejectMove, subtreeHeight } from './tree.ts'
import type { TreeNode } from './tree.ts'

/**
 * The tree rules, without a database. These are the checks a self-referencing
 * foreign key cannot make, so they are the ones worth exercising directly.
 */

function node(id: string, parentId: string | null, sortOrder: number): TreeNode {
  return { id, parentId, sortOrder }
}

/** A chain five levels deep, `a` at the top, plus two roots beside it. */
const chain: readonly TreeNode[] = [
  node('a', null, 0),
  node('b', 'a', 0),
  node('c', 'b', 0),
  node('d', 'c', 0),
  node('e', 'd', 0),
  node('x', null, 1),
  node('y', null, 2),
]

describe('childrenOf', () => {
  it('returns one parent’s children in sibling order', () => {
    const pages = [node('second', 'a', 1), node('first', 'a', 0), node('elsewhere', 'b', 0)]

    expect(childrenOf(pages, 'a').map((page) => page.id)).toEqual(['first', 'second'])
  })

  it('treats null as the top level', () => {
    expect(childrenOf(chain, null).map((page) => page.id)).toEqual(['a', 'x', 'y'])
  })

  it('breaks a shared position by id rather than leaving it to the caller', () => {
    const pages = [node('zebra', null, 0), node('alpha', null, 0)]

    expect(childrenOf(pages, null).map((page) => page.id)).toEqual(['alpha', 'zebra'])
  })
})

describe('descendantIds', () => {
  it('collects every page below one, at any depth', () => {
    expect([...descendantIds(chain, 'a')].sort()).toEqual(['b', 'c', 'd', 'e'])
  })

  it('is empty for a leaf', () => {
    expect(descendantIds(chain, 'e').size).toBe(0)
  })

  it('terminates on a cycle the service could not have written', () => {
    const cyclic = [node('one', 'two', 0), node('two', 'one', 0)]

    expect([...descendantIds(cyclic, 'one')].sort()).toEqual(['one', 'two'])
  })
})

describe('depthOf', () => {
  it('counts a top-level page as zero', () => {
    expect(depthOf(chain, 'a')).toBe(0)
  })

  it('counts levels down the chain', () => {
    expect(depthOf(chain, 'e')).toBe(4)
  })

  it('reports a broken ancestry as over the cap rather than as shallow', () => {
    const orphan = [node('lost', 'gone', 0)]

    expect(depthOf(orphan, 'lost')).toBe(1)
    expect(depthOf([node('one', 'two', 0), node('two', 'one', 0)], 'one')).toBe(MAX_DEPTH + 1)
  })
})

describe('subtreeHeight', () => {
  it('is zero for a leaf', () => {
    expect(subtreeHeight(chain, 'e')).toBe(0)
  })

  it('counts the levels a move would carry along', () => {
    expect(subtreeHeight(chain, 'a')).toBe(4)
    expect(subtreeHeight(chain, 'c')).toBe(2)
  })
})

describe('rejectMove', () => {
  it('allows an ordinary re-nest', () => {
    expect(rejectMove(chain, 'x', 'y')).toBeUndefined()
  })

  it('allows a move to the top level', () => {
    expect(rejectMove(chain, 'c', null)).toBeUndefined()
  })

  it('refuses a page under itself', () => {
    expect(rejectMove(chain, 'b', 'b')).toBe('self')
  })

  it('refuses a page under its own subpage', () => {
    expect(rejectMove(chain, 'a', 'd')).toBe('descendant')
  })

  it('refuses a parent that is not in this workspace', () => {
    expect(rejectMove(chain, 'x', 'somebody-elses-page')).toBe('missing_parent')
  })

  it('refuses a move that would put the page itself past the cap', () => {
    expect(rejectMove(chain, 'x', 'e')).toBe('too_deep')
  })

  it('refuses a move that would push the page’s own subpages past the cap', () => {
    // `b` carries three levels below it, so hanging it off `x` is fine and
    // hanging it off `y`'s child would not be.
    expect(rejectMove([...chain, node('deep', 'x', 0)], 'b', 'deep')).toBe('too_deep')
    expect(rejectMove(chain, 'b', 'x')).toBeUndefined()
  })
})

describe('placeAt', () => {
  const siblings = [node('one', null, 0), node('two', null, 1)]
  const moving = node('new', null, 0)

  it('inserts at the position given', () => {
    expect(placeAt(siblings, moving, 1).map((page) => page.id)).toEqual(['one', 'new', 'two'])
  })

  it('puts a position past the end at the end', () => {
    expect(placeAt(siblings, moving, 99).map((page) => page.id)).toEqual(['one', 'two', 'new'])
  })

  it('puts a negative position at the start', () => {
    expect(placeAt(siblings, moving, -3).map((page) => page.id)).toEqual(['new', 'one', 'two'])
  })
})

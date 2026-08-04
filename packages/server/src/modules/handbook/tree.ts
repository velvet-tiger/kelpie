/**
 * The handbook tree's rules, as plain functions over the rows.
 *
 * A self-referencing foreign key can express a tree but not its bounds: nothing
 * in Postgres refuses a page nested under its own child, and nothing counts
 * levels. `schema.md` puts both in the service, and they live here rather than in
 * `service.ts` so they can be exercised without a database.
 *
 * Every function takes one workspace's pages. They are small enough to walk in
 * memory, and a single snapshot is what makes a sequence of checks agree with
 * each other.
 */

/**
 * How deep a page may sit, counting a top-level page as 0.
 *
 * Four, the mockup's `MAX_DEPTH`, so five levels are reachable. The cap exists
 * because the sidebar indents by a fixed 14px per level and a sixth level has
 * nowhere left to go in a 260px column.
 */
export const MAX_DEPTH = 4

/** What the tree rules need off a page. The service passes stored rows, which carry more. */
export interface TreeNode {
  readonly id: string
  readonly parentId: string | null
  readonly sortOrder: number
}

/**
 * One parent's children, in sibling order. `parentId: null` gives the top level.
 *
 * The id tiebreak never fires while the service keeps a sibling set contiguous
 * from 0, but two rows sharing a position must still come back in a fixed order
 * rather than the one the planner happened to choose.
 */
export function childrenOf<TNode extends TreeNode>(
  nodes: readonly TNode[],
  parentId: string | null,
): TNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
}

/** Every page under this one, at any depth. The set a delete takes with it, and the set a move may not land in. */
export function descendantIds(nodes: readonly TreeNode[], rootId: string): ReadonlySet<string> {
  const found = new Set<string>()
  const pending = [rootId]

  while (pending.length > 0) {
    const parentId = pending.pop()

    for (const child of nodes.filter((node) => node.parentId === parentId)) {
      // A cycle would loop forever. The service cannot create one, but this
      // walks whatever is in the table rather than trusting that.
      if (!found.has(child.id)) {
        found.add(child.id)
        pending.push(child.id)
      }
    }
  }

  return found
}

/**
 * How deep a page sits, counting a top-level page as 0.
 *
 * @returns The depth, or `MAX_DEPTH + 1` if the chain above the page is broken
 *   or circular. That is deliberately over the cap: a page whose ancestry cannot
 *   be resolved must fail a depth check rather than pass one.
 */
export function depthOf(nodes: readonly TreeNode[], id: string): number {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let cursor = byId.get(id)?.parentId ?? null
  let depth = 0

  while (cursor !== null) {
    depth += 1

    if (depth > MAX_DEPTH) {
      return MAX_DEPTH + 1
    }

    cursor = byId.get(cursor)?.parentId ?? null
  }

  return depth
}

/** How many levels sit below a page: 0 when it has no children. A move carries this with it. */
export function subtreeHeight(nodes: readonly TreeNode[], rootId: string): number {
  const children = nodes.filter((node) => node.parentId === rootId)

  if (children.length === 0) {
    return 0
  }

  return 1 + Math.max(...children.map((child) => subtreeHeight(nodes, child.id)))
}

/** Why a move was refused. The service turns each into a 422 with its own message. */
export type MoveRejection = 'self' | 'descendant' | 'missing_parent' | 'too_deep'

/**
 * Whether a page may become a child of `parentId`.
 *
 * The three refusals are different mistakes and the caller is told which. Depth
 * counts the whole subtree, not just the page: re-nesting a branch three levels
 * tall under a level-two parent would push its leaves past the cap even though
 * the page itself lands inside it.
 *
 * @param parentId The proposed parent, or null for the top level.
 * @returns undefined when the move is allowed.
 */
export function rejectMove(
  nodes: readonly TreeNode[],
  pageId: string,
  parentId: string | null,
): MoveRejection | undefined {
  if (parentId === null) {
    return subtreeHeight(nodes, pageId) > MAX_DEPTH ? 'too_deep' : undefined
  }

  if (parentId === pageId) {
    return 'self'
  }

  if (!nodes.some((node) => node.id === parentId)) {
    return 'missing_parent'
  }

  if (descendantIds(nodes, pageId).has(parentId)) {
    return 'descendant'
  }

  return depthOf(nodes, parentId) + 1 + subtreeHeight(nodes, pageId) > MAX_DEPTH
    ? 'too_deep'
    : undefined
}

/**
 * A sibling set with one page placed at `position`, 0-based.
 *
 * @param siblings The set the page is joining, in order, without the page itself.
 * @param position Where it lands. Past the end is the end, which is what an
 *   absent position means and what a drag to the bottom of a list produces.
 */
export function placeAt<TNode extends TreeNode>(
  siblings: readonly TNode[],
  page: TNode,
  position: number,
): TNode[] {
  const index = Math.max(0, Math.min(position, siblings.length))

  return [...siblings.slice(0, index), page, ...siblings.slice(index)]
}

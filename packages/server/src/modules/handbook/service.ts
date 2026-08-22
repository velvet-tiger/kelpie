import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { Transaction, TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import * as repository from './repository.ts'
import { DEFAULT_HANDBOOK_PAGE_SORT, HANDBOOK_PAGE_SORTS } from './repository.ts'
import type { HandbookPageFilters, HandbookPageRecord } from './repository.ts'
import { slugFromTitle, uniqueSlug } from './slugs.ts'
import { MAX_DEPTH, childrenOf, depthOf, descendantIds, placeAt, rejectMove } from './tree.ts'
import type { MoveRejection } from './tree.ts'

/**
 * The handbook: nested markdown pages, read by people in a sidebar and by agents
 * over the same endpoints.
 *
 * This service owns the two rules the schema cannot hold. Depth and the
 * no-descendant-cycles rule are checked here because a self-referencing foreign
 * key expresses the shape of a tree and nothing about its bounds. Sibling order
 * is kept contiguous from 0 for the same reason a pipeline's is: it is what lets
 * a PATCHed `sort_order` mean "position in the sidebar" rather than an opaque
 * number a client has to guess a gap in.
 */

export interface HandbookDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

/** A page as the API returns one: the stored row minus the tenancy column. */
export type HandbookPageView = Omit<HandbookPageRecord, 'workspaceId'>

export interface CreateHandbookPageInput {
  readonly title: string
  /** Absent means empty. A page is created before it is written, which is the point of "Add subpage". */
  readonly body: string
  /** Absent means derived from the title, with a numeric suffix if that is taken. */
  readonly slug: string | undefined
  /** Null means top level. */
  readonly parentId: string | null
}

/**
 * PATCH semantics: an absent field is left alone.
 *
 * `parentId` and `sortOrder` are the move; `title`, `body` and `slug` are the
 * edit. A request may carry both, and the two are applied in that order so the
 * page ends up where it was put with what it was given.
 */
export interface UpdateHandbookPageInput {
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly slug?: string | undefined
  /** Null moves the page to the top level. */
  readonly parentId?: string | null | undefined
  /** The page's new position among its siblings, 0-based. */
  readonly sortOrder?: number | undefined
}

export interface HandbookService {
  list(
    actor: Actor,
    filters: HandbookPageFilters,
    query: ListQueryParameters,
  ): Promise<Page<HandbookPageView>>
  get(actor: Actor, id: string): Promise<HandbookPageView>
  create(actor: Actor, input: CreateHandbookPageInput): Promise<HandbookPageView>
  update(actor: Actor, id: string, changes: UpdateHandbookPageInput): Promise<HandbookPageView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: HandbookPageRecord): HandbookPageView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

/** The 422 a refused move produces. Each rejection is a different mistake, so each says something different. */
function moveRefused(rejection: MoveRejection): AppError {
  const messages: Readonly<Record<MoveRejection, string>> = {
    self: 'A page cannot be nested under itself',
    descendant: 'A page cannot be nested under one of its own subpages',
    missing_parent: 'That parent page is not in this workspace',
    too_deep: `The handbook nests ${String(MAX_DEPTH + 1)} levels deep at most`,
  }

  return AppError.validationFailed(messages[rejection], [
    { field: 'parent_id', message: messages[rejection] },
  ])
}

function duplicateSlug(): AppError {
  return AppError.conflict('A handbook page in this workspace already uses that address', [
    { field: 'slug', message: 'Already in use' },
  ])
}

export function createHandbookService(dependencies: HandbookDependencies): HandbookService {
  async function require(workspaceId: string, id: string): Promise<HandbookPageRecord> {
    const page = await repository.findPage(dependencies.db, workspaceId, id)

    // A page in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (page === undefined) {
      throw AppError.notFound('Handbook page not found')
    }

    return page
  }

  /**
   * Writes a sibling set back as positions 0..n-1, touching only the rows that
   * moved, and re-parenting `reparented` if it is one of them.
   *
   * `updated_at` and `updated_by` are deliberately not written. They say who last
   * wrote the page, which is the line the reader sees under its title, and a page
   * that shifted down one because a neighbour was dragged above it was not
   * written by anybody.
   */
  async function renumber(
    tx: Transaction,
    workspaceId: string,
    order: readonly HandbookPageRecord[],
    reparented: { readonly id: string; readonly parentId: string | null } | undefined,
  ): Promise<void> {
    for (const [index, page] of order.entries()) {
      const movesParent = reparented !== undefined && reparented.id === page.id
      const movesOrder = page.sortOrder !== index

      if (!movesParent && !movesOrder) {
        continue
      }

      await repository.updatePage(tx, workspaceId, page.id, {
        ...(movesParent ? { parentId: reparented.parentId } : {}),
        sortOrder: index,
      })
    }
  }

  /**
   * Applies a move, and reports which fields it changed.
   *
   * The page is lifted out of its sibling set and dropped into the target one at
   * `position`, then both sets are renumbered. When the parent does not change
   * there is only one set, and lifting then re-inserting is what turns a
   * `sort_order` of 2 into "third among your siblings" rather than a raw column
   * write that could leave two pages sharing a position.
   *
   * @param position Absent leaves the page where it sits, which for a re-nest
   *   means the end of its new sibling set: there is no position to keep.
   */
  async function move(
    tx: Transaction,
    workspaceId: string,
    page: HandbookPageRecord,
    parentId: string | null,
    position: number | undefined,
  ): Promise<readonly string[]> {
    const all = await repository.listAllPages(tx, workspaceId)
    const changesParent = parentId !== page.parentId

    if (changesParent) {
      const rejection = rejectMove(all, page.id, parentId)

      if (rejection !== undefined) {
        throw moveRefused(rejection)
      }
    }

    const siblings = childrenOf(all, parentId).filter((sibling) => sibling.id !== page.id)
    const held = childrenOf(all, page.parentId).findIndex((sibling) => sibling.id === page.id)

    await renumber(
      tx,
      workspaceId,
      placeAt(siblings, page, position ?? (changesParent ? siblings.length : held)),
      changesParent ? { id: page.id, parentId } : undefined,
    )

    if (changesParent) {
      await renumber(tx, workspaceId, siblingsOf(all, page), undefined)
    }

    const moved = await repository.findPage(tx, workspaceId, page.id)

    if (moved === undefined) {
      throw AppError.notFound('Handbook page not found')
    }

    return [
      ...(changesParent ? ['parentId'] : []),
      ...(moved.sortOrder === page.sortOrder ? [] : ['sortOrder']),
    ]
  }

  /** The set a page is leaving, without the page. Renumbered so it stays contiguous from 0. */
  function siblingsOf(
    all: readonly HandbookPageRecord[],
    page: HandbookPageRecord,
  ): HandbookPageRecord[] {
    return childrenOf(all, page.parentId).filter((sibling) => sibling.id !== page.id)
  }

  /**
   * The edit half of a PATCH: what the page says, and who last said it.
   *
   * `updated_at` and `updated_by` are stamped here and nowhere else, so a request
   * that only moved the page leaves them alone. Re-reads instead of writing when
   * nothing about the content changed, because the row may still have been
   * renumbered by the move that ran first.
   */
  async function writeContent(
    tx: Transaction,
    workspaceId: string,
    id: string,
    columns: Partial<repository.HandbookPageColumns>,
    actor: Actor,
    changed: boolean,
  ): Promise<HandbookPageRecord | undefined> {
    if (!changed) {
      return repository.findPage(tx, workspaceId, id)
    }

    try {
      return await repository.updatePage(tx, workspaceId, id, {
        ...columns,
        updatedBy: actorMemberId(actor),
        updatedAt: dependencies.now(),
      })
    } catch (error: unknown) {
      if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
        throw duplicateSlug()
      }

      throw error
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, HANDBOOK_PAGE_SORTS, DEFAULT_HANDBOOK_PAGE_SORT)
      const rows = await repository.listPages(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (page) => page.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('handbookPage')

      return dependencies.transaction(async ({ tx, events }) => {
        const all = await repository.listAllPages(tx, workspaceId)

        if (input.parentId !== null) {
          const parent = all.find((page) => page.id === input.parentId)

          if (parent === undefined) {
            throw moveRefused('missing_parent')
          }

          // A new page carries no subtree, so its own depth is the whole check.
          if (depthOf(all, parent.id) + 1 > MAX_DEPTH) {
            throw moveRefused('too_deep')
          }
        }

        const taken = new Set(all.map((page) => page.slug))
        const siblings = childrenOf(all, input.parentId)

        try {
          const created = await repository.insertPage(tx, {
            id,
            workspaceId,
            title: input.title,
            slug: input.slug ?? uniqueSlug(taken, slugFromTitle(input.title)),
            parentId: input.parentId,
            sortOrder: siblings.length,
            body: input.body,
            updatedBy: actorMemberId(actor),
          })

          events.emit('handbook.page.created', { type: 'handbook_page', id }, {})

          return toView(created)
        } catch (error: unknown) {
          // A slug given by the caller, or two concurrent creates that derived
          // the same one from the same read of `taken`.
          if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
            throw duplicateSlug()
          }

          throw error
        }
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns = {
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.slug === undefined ? {} : { slug: changes.slug }),
      }
      const written = changedKeys(existing, columns)
      const moves = changes.parentId !== undefined || changes.sortOrder !== undefined

      if (written.length === 0 && !moves) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        const movedFields = moves
          ? await move(
              tx,
              workspaceId,
              existing,
              changes.parentId === undefined ? existing.parentId : changes.parentId,
              changes.sortOrder,
            )
          : []

        const updated = await writeContent(tx, workspaceId, id, columns, actor, written.length > 0)

        if (updated === undefined) {
          throw AppError.notFound('Handbook page not found')
        }

        const changed = [...written, ...movedFields]

        if (changed.length > 0) {
          events.emit('handbook.page.updated', { type: 'handbook_page', id }, { changed })
        }

        return toView(updated)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    /**
     * Deletes the page and every page nested under it.
     *
     * The subtree goes through the self-referencing foreign key's cascade, so the
     * ids are read first: a webhook consumer mirroring the handbook needs one
     * `record.deleted` per page that is gone, not one for the page a person
     * happened to click on.
     *
     * Siblings shifting up afterwards emit nothing. A consumer that mirrors order
     * re-reads the sibling set, which is the same thing it does after a drag.
     */
    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        const all = await repository.listAllPages(tx, workspaceId)
        const page = all.find((candidate) => candidate.id === id)

        if (page === undefined) {
          throw AppError.notFound('Handbook page not found')
        }

        const removed = [id, ...descendantIds(all, id)]

        await repository.deletePage(tx, workspaceId, id)
        await renumber(
          tx,
          workspaceId,
          childrenOf(all, page.parentId).filter((sibling) => sibling.id !== id),
          undefined,
        )

        for (const recordId of removed) {
          events.emit('handbook.page.deleted', { type: 'handbook_page', id: recordId }, {})
        }
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

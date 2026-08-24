import { changedKeys } from '../../lib/changes.ts'
import { UNIQUE_VIOLATION, postgresErrorCode } from '../../lib/database.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { missingTargets, resolveTargetNames, targetKey } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import './events.ts'
import * as repository from './repository.ts'
import {
  DEFAULT_LIST_MEMBER_SORT,
  DEFAULT_LIST_SORT,
  LIST_MEMBER_SORTS,
  LIST_SORTS,
} from './repository.ts'
import type {
  ListFilters,
  ListMemberFilters,
  ListMemberRecord,
  ListWithCount,
  MembershipWithList,
} from './repository.ts'

/**
 * Lists: named collections of records of one type.
 *
 * The type is fixed at creation. A member's type must match the parent list's,
 * a rule the database enforces through a composite foreign key. The service
 * checks the same before the insert so a mismatch produces a friendly 422
 * rather than a driver error the caller has to decode.
 */

export interface ListsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

/** A list as the API returns one: the stored row minus the tenancy column. */
export type ListView = Omit<ListWithCount, 'workspaceId'>

/** A membership plus the list it points at, as `/v1/list-memberships` returns one. */
export interface ListMembershipView {
  readonly id: string
  readonly listId: string
  readonly listName: string
  readonly listTargetType: RecordTargetType
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly addedAt: Date
}

/** A member enriched with the resolved name of the record it points at. */
export interface ListMemberView {
  readonly id: string
  readonly listId: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly targetName: string | null
  readonly addedAt: Date
}

export interface CreateListInput {
  readonly name: string
  readonly targetType: RecordTargetType
  readonly description: string | null
}

/** PATCH semantics: an absent field is left alone. The type never moves. */
export interface UpdateListInput {
  readonly name?: string | undefined
  readonly description?: string | null | undefined
}

export interface AddListMemberInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
}

export interface ListsService {
  list(actor: Actor, filters: ListFilters, query: ListQueryParameters): Promise<Page<ListView>>
  get(actor: Actor, id: string): Promise<ListView>
  create(actor: Actor, input: CreateListInput): Promise<ListView>
  update(actor: Actor, id: string, changes: UpdateListInput): Promise<ListView>
  remove(actor: Actor, id: string): Promise<void>
  listMembers(
    actor: Actor,
    filters: ListMemberFilters,
    query: ListQueryParameters,
  ): Promise<Page<ListMemberView>>
  addMember(actor: Actor, listId: string, input: AddListMemberInput): Promise<ListMemberView>
  removeMember(actor: Actor, listId: string, id: string): Promise<void>
  membershipsFor(
    actor: Actor,
    targetType: RecordTargetType,
    targetId: string,
  ): Promise<readonly ListMembershipView[]>
}

function toView(record: ListWithCount): ListView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

function toMembershipView(row: MembershipWithList): ListMembershipView {
  return {
    id: row.id,
    listId: row.listId,
    listName: row.listName,
    listTargetType: row.listTargetType as RecordTargetType,
    targetType: row.targetType as RecordTargetType,
    targetId: row.targetId,
    addedAt: row.addedAt,
  }
}

function toMemberView(record: ListMemberRecord, name: string | undefined): ListMemberView {
  return {
    id: record.id,
    listId: record.listId,
    targetType: record.targetType as RecordTargetType,
    targetId: record.targetId,
    targetName: name ?? null,
    addedAt: record.addedAt,
  }
}

function duplicateName(): AppError {
  return AppError.conflict('Another list in this workspace already has that name', [
    { field: 'name', message: 'Already in use' },
  ])
}

function typeMismatch(expected: RecordTargetType, got: RecordTargetType): AppError {
  return AppError.validationFailed(
    `That record cannot join a ${expected} list`,
    [
      {
        field: 'target_type',
        message: `Expected ${expected} to match the list's type, got ${got}`,
      },
    ],
  )
}

function alreadyMember(): AppError {
  return AppError.conflict('That record is already on the list', [
    { field: 'target_id', message: 'Already a member' },
  ])
}

export function createListsService(dependencies: ListsDependencies): ListsService {
  async function require(workspaceId: string, id: string): Promise<ListWithCount> {
    const list = await repository.findList(dependencies.db, workspaceId, id)

    if (list === undefined) {
      throw AppError.notFound('List not found')
    }

    return list
  }

  async function requireTarget(
    workspaceId: string,
    targetType: RecordTargetType,
    targetId: string,
  ): Promise<void> {
    const missing = await missingTargets(dependencies.db, workspaceId, targetType, [targetId])

    if (missing.length > 0) {
      throw AppError.notFound('Record not found')
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, LIST_SORTS, DEFAULT_LIST_SORT)
      const rows = await repository.listLists(dependencies.db, workspaceId, filters, window)

      return mapPage(toPage(rows, window, (row) => row.id), toView)
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('list')

      return dependencies.transaction(
        async ({ tx, events }) => {
          let created
          try {
            created = await repository.insertList(tx, {
              id,
              workspaceId,
              name: input.name,
              description: input.description,
              targetType: input.targetType,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateName()
            }

            throw error
          }

          events.emit('lists.list.created', { type: 'list', id: created.id }, {})

          return toView({ ...created, memberCount: 0 })
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)
      const columns: Partial<repository.ListColumns> = {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
      }
      const changed = changedKeys(existing, columns)

      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(
        async ({ tx, events }) => {
          let updated
          try {
            updated = await repository.updateList(tx, workspaceId, id, {
              ...columns,
              updatedAt: dependencies.now(),
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateName()
            }

            throw error
          }

          if (updated === undefined) {
            throw AppError.notFound('List not found')
          }

          events.emit('lists.list.updated', { type: 'list', id }, { changed })

          return toView({ ...updated, memberCount: existing.memberCount })
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(
        async ({ tx, events }) => {
          await require(workspaceId, id)
          // Members cascade with the list; nothing else references it.
          await repository.deleteList(tx, workspaceId, id)

          events.emit('lists.list.deleted', { type: 'list', id }, {})
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async listMembers(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      // The list must exist. A caller reading members of a missing list gets a
      // 404, not a silent empty page.
      await require(workspaceId, filters.listId)

      const window = readListWindow(query, LIST_MEMBER_SORTS, DEFAULT_LIST_MEMBER_SORT)
      const rows = await repository.listListMembers(dependencies.db, workspaceId, filters, window)
      const names = await resolveTargetNames(
        dependencies.db,
        workspaceId,
        rows.map((row) => ({
          targetType: row.targetType as RecordTargetType,
          targetId: row.targetId,
        })),
      )
      const page = toPage(rows, window, (row) => row.id)

      return mapPage(page, (row) =>
        toMemberView(
          row,
          names.get(
            targetKey({
              targetType: row.targetType as RecordTargetType,
              targetId: row.targetId,
            }),
          ),
        ),
      )
    },

    async addMember(actor, listId, input) {
      const workspaceId = requireWorkspaceId(actor)
      const list = await require(workspaceId, listId)

      if (list.targetType !== input.targetType) {
        throw typeMismatch(list.targetType as RecordTargetType, input.targetType)
      }

      await requireTarget(workspaceId, input.targetType, input.targetId)

      const id = dependencies.createId('listMember')

      return dependencies.transaction(
        async ({ tx, events }) => {
          let created
          try {
            created = await repository.insertListMember(tx, {
              id,
              workspaceId,
              listId,
              targetType: input.targetType,
              targetId: input.targetId,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw alreadyMember()
            }

            throw error
          }

          events.emit(
            'lists.member.added',
            { type: input.targetType, id: input.targetId },
            { listId },
          )

          const names = await resolveTargetNames(tx, workspaceId, [
            { targetType: input.targetType, targetId: input.targetId },
          ])

          return toMemberView(
            created,
            names.get(targetKey({ targetType: input.targetType, targetId: input.targetId })),
          )
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async membershipsFor(actor, targetType, targetId) {
      const workspaceId = requireWorkspaceId(actor)
      // The target must exist. A caller listing memberships of a missing record
      // gets 404, not a silent empty list — same rule as notes/decisions.
      await requireTarget(workspaceId, targetType, targetId)

      const rows = await repository.listMembershipsForTarget(
        dependencies.db,
        workspaceId,
        targetType,
        targetId,
      )

      return rows.map(toMembershipView)
    },

    async removeMember(actor, listId, id) {
      const workspaceId = requireWorkspaceId(actor)
      await require(workspaceId, listId)

      const existing = await repository.findListMember(dependencies.db, workspaceId, listId, id)

      if (existing === undefined) {
        throw AppError.notFound('List member not found')
      }

      await dependencies.transaction(
        async ({ tx, events }) => {
          await repository.deleteListMember(tx, workspaceId, listId, id)

          events.emit(
            'lists.member.removed',
            { type: existing.targetType as RecordTargetType, id: existing.targetId },
            { listId },
          )
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },
  }
}

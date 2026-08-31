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
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
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

/**
 * A list as the API returns one: the stored row minus the tenancy column,
 * plus the denormalised slug of the consent purpose (when set) so a reader
 * needs no second call.
 */
export type ListView = Omit<ListWithCount, 'workspaceId'> & {
  readonly consentPurposeSlug: string | null
}

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
  /**
   * Optional consent purpose captured on form-driven adds. Person lists only.
   * A non-null value on any other target type is refused at 422.
   */
  readonly consentPurposeId: string | null
}

/** PATCH semantics: an absent field is left alone. The type never moves. */
export interface UpdateListInput {
  readonly name?: string | undefined
  readonly description?: string | null | undefined
  readonly consentPurposeId?: string | null | undefined
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

function toView(record: ListWithCount, consentPurposeSlug: string | null): ListView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, consentPurposeSlug }
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

function purposeNotPersonList(): AppError {
  return AppError.validationFailed(
    'Only person lists capture consent — remove consent_purpose_id or change the list type',
    [{ field: 'consent_purpose_id', message: 'Person lists only' }],
  )
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

  async function resolveConsentPurposeSlug(
    workspaceId: string,
    purposeId: string | null,
  ): Promise<string | null> {
    if (purposeId === null) return null
    const [row] = await consentPurposesRepository.listPurposesByIds(
      dependencies.db,
      workspaceId,
      [purposeId],
    )
    return row?.slug ?? null
  }

  async function requireConsentPurposeExists(
    workspaceId: string,
    purposeId: string,
  ): Promise<void> {
    const rows = await consentPurposesRepository.listPurposesByIds(
      dependencies.db,
      workspaceId,
      [purposeId],
    )
    if (rows.length === 0) {
      throw AppError.validationFailed('That consent purpose was not found', [
        { field: 'consent_purpose_id', message: `No purpose ${purposeId} here` },
      ])
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, LIST_SORTS, DEFAULT_LIST_SORT)
      const rows = await repository.listLists(dependencies.db, workspaceId, filters, window)
      const purposeIds = Array.from(
        new Set(
          rows
            .map((row) => row.consentPurposeId)
            .filter((id): id is string => id !== null),
        ),
      )
      const purposes = await consentPurposesRepository.listPurposesByIds(
        dependencies.db,
        workspaceId,
        purposeIds,
      )
      const slugByPurpose = new Map(purposes.map((purpose) => [purpose.id, purpose.slug]))

      return mapPage(toPage(rows, window, (row) => row.id), (row) =>
        toView(row, row.consentPurposeId === null ? null : (slugByPurpose.get(row.consentPurposeId) ?? null)),
      )
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const record = await require(workspaceId, id)
      const slug = await resolveConsentPurposeSlug(workspaceId, record.consentPurposeId)
      return toView(record, slug)
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)
      const id = dependencies.createId('list')

      if (input.consentPurposeId !== null) {
        if (input.targetType !== 'person') {
          throw purposeNotPersonList()
        }
        await requireConsentPurposeExists(workspaceId, input.consentPurposeId)
      }

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
              consentPurposeId: input.consentPurposeId,
            })
          } catch (error: unknown) {
            if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
              throw duplicateName()
            }

            throw error
          }

          events.emit('lists.list.created', { type: 'list', id: created.id }, {})

          const slug = await resolveConsentPurposeSlug(
            workspaceId,
            created.consentPurposeId,
          )

          return toView({ ...created, memberCount: 0 }, slug)
        },
        { workspaceId, actor: toEventActor(actor) },
      )
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (
        changes.consentPurposeId !== undefined &&
        changes.consentPurposeId !== null &&
        existing.targetType !== 'person'
      ) {
        throw purposeNotPersonList()
      }
      if (
        changes.consentPurposeId !== undefined &&
        changes.consentPurposeId !== null
      ) {
        await requireConsentPurposeExists(workspaceId, changes.consentPurposeId)
      }

      const columns: Partial<repository.ListColumns> = {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.consentPurposeId === undefined
          ? {}
          : { consentPurposeId: changes.consentPurposeId }),
      }
      const changed = changedKeys(existing, columns)

      if (changed.length === 0) {
        const slug = await resolveConsentPurposeSlug(workspaceId, existing.consentPurposeId)
        return toView(existing, slug)
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

          const slug = await resolveConsentPurposeSlug(workspaceId, updated.consentPurposeId)

          return toView({ ...updated, memberCount: existing.memberCount }, slug)
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

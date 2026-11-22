import type { EventActor } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { missingTargets } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { listsEvents } from './events.ts'
import * as repository from './repository.ts'
import { mountListsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createListsService, typeMismatch } from './service.ts'
import { registerListsTools } from './tools.ts'

/**
 * Lists: named collections of records of one type.
 *
 * Requires `workspace` for the tenancy column. Every other record type is
 * addressed polymorphically through `target_type` + `target_id`, so this module
 * does not depend on the modules whose records it references.
 */
export function createListsModule(migrationsDirectory: string): KelpieModule {
  return {
    id: 'lists',
    requires: ['workspace'],
    structural: true,
    events: listsEvents,

    register(context) {
      const service = createListsService({
        db: context.db,
        transaction: context.transaction,
        createId: context.createId,
        now: context.now,
      })

      context.schema(schema, migrationsDirectory)

      context.routes((router) => {
        mountListsRoutes(router, { db: context.db, now: context.now, service })
      })

      registerListsTools(context.mcp, service)

      return Promise.resolve()
    },
  }
}

/** Dependencies a caller outside the lists module already holds. */
export interface RemoveListMemberByTargetDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
}

export interface RemoveListMemberByTargetInput {
  readonly workspaceId: string
  readonly listId: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  /**
   * The event actor to stamp on `lists.member.removed`. An integration webhook
   * that has no signed-in user passes `{ kind: 'system' }`; a module acting on
   * behalf of a user passes `{ kind: 'user', id: userId }`.
   */
  readonly actor: EventActor
}

/**
 * Removes a person (or any record) from a list by target, from outside the lists module.
 *
 * The path an integration takes when a signal from an external system removes
 * membership — a Resend unsubscribe removing the person from every mapped list,
 * a compliance sweep evicting a record — and there is no signed-in user to
 * hang a normal `removeMember(actor, listId, id)` call on. Every safeguard the
 * REST route enforces (workspace membership, ownership of the list, presence
 * of the member row) is skipped here on purpose: the caller has already
 * decided, and the input is trusted because it comes from another module in
 * the same assembly rather than a request body.
 *
 * @returns `true` if the row was on the list and is now gone (emits
 *   `lists.member.removed`), `false` if the target was not a member — a no-op
 *   so a delivery redelivered by an at-least-once webhook is safe.
 */
export async function removeListMemberByTarget(
  dependencies: RemoveListMemberByTargetDependencies,
  input: RemoveListMemberByTargetInput,
): Promise<boolean> {
  return dependencies.transaction(
    async ({ tx, events }) => {
      const deleted = await repository.deleteListMemberByTarget(
        tx,
        input.workspaceId,
        input.listId,
        input.targetType,
        input.targetId,
      )

      if (deleted === undefined) {
        return false
      }

      events.emit(
        'lists.member.removed',
        { type: input.targetType, id: input.targetId },
        { listId: input.listId },
      )

      return true
    },
    { workspaceId: input.workspaceId, actor: input.actor },
  )
}

/** Dependencies a caller outside the lists module already holds. */
export interface AddListMemberByTargetDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  /** Mints the member row's id. A module passes its `context.createId`. */
  readonly createId: IdFactory
}

export interface AddListMemberByTargetInput {
  readonly workspaceId: string
  readonly listId: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  /** The event actor to stamp on `lists.member.added`. Same rule as removal. */
  readonly actor: EventActor
}

/**
 * Adds a record to a list by target, from outside the lists module.
 *
 * The mirror of `removeListMemberByTarget`, for an integration that pulls
 * membership in from an external system (a Resend segment synced into a list)
 * with no signed-in user to hang a normal `addMember` call on. The caller's
 * decision is trusted, but the data rules still hold, because breaking them
 * would store a row no other path could have written:
 *
 * - the list must exist in `workspaceId`, or this throws `AppError.notFound`
 *   (`List not found`) — the same answer the REST route gives, so a list id
 *   from another workspace is indistinguishable from a missing one;
 * - `targetType` must match the list's type, or this throws the route's own
 *   422 (`typeMismatch`);
 * - the target must exist in the workspace, or this throws
 *   `AppError.notFound` (`Record not found`).
 *
 * Unlike the route, an existing membership is not a 409. It is a no-op, so a
 * sync that runs again over the same segment is safe.
 *
 * @returns `true` if the row was inserted (emits `lists.member.added` with the
 *   same payload as the route), `false` if the target was already a member
 *   (no insert, no event).
 */
export async function addListMemberByTarget(
  dependencies: AddListMemberByTargetDependencies,
  input: AddListMemberByTargetInput,
): Promise<boolean> {
  return dependencies.transaction(
    async ({ tx, events }) => {
      const list = await repository.findList(tx, input.workspaceId, input.listId)

      if (list === undefined) {
        throw AppError.notFound('List not found')
      }

      if (list.targetType !== input.targetType) {
        throw typeMismatch(list.targetType as RecordTargetType, input.targetType)
      }

      const missing = await missingTargets(tx, input.workspaceId, input.targetType, [
        input.targetId,
      ])

      if (missing.length > 0) {
        throw AppError.notFound('Record not found')
      }

      const created = await repository.insertListMemberIfAbsent(tx, {
        id: dependencies.createId('listMember'),
        workspaceId: input.workspaceId,
        listId: input.listId,
        targetType: input.targetType,
        targetId: input.targetId,
      })

      if (created === undefined) {
        return false
      }

      events.emit(
        'lists.member.added',
        { type: input.targetType, id: input.targetId },
        { listId: input.listId },
      )

      return true
    },
    { workspaceId: input.workspaceId, actor: input.actor },
  )
}

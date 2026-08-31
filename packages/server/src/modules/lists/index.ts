import type { EventActor } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import type { KelpieModule } from '../../runtime/module.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import { listsEvents } from './events.ts'
import * as repository from './repository.ts'
import { mountListsRoutes } from './routes.ts'
import * as schema from './schema.ts'
import { createListsService } from './service.ts'
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

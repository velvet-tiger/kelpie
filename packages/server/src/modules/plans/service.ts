import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import { targetExists } from '../recordTargets.ts'
import * as repository from './repository.ts'
import { DEFAULT_PLAN_ITEM_SORT, PLAN_ITEM_SORTS } from './repository.ts'
import type { PlanItemFilters, PlanItemRecord } from './repository.ts'
import type { PipelineKind, PlanItemStatus } from './schema.ts'

/**
 * Plan items: the dated next steps on a Deal, Opportunity, Raise or Partnership.
 *
 * The target is polymorphic and has no foreign key, so this service is what
 * refuses a plan item attached to an id that does not exist or belongs to another
 * workspace. Nothing in the database would.
 *
 * No activity rows. `ACTIVITY_KINDS` carries nothing that describes a plan item,
 * and filing one under `updated` would put a sentence on a timeline about a
 * record the timeline is not for. Adding a kind is a check-constraint migration
 * and belongs to whichever feature decides plan history is worth keeping.
 */

export interface PlansDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

/** A plan item as the API returns one: the stored row minus the tenancy column. */
export type PlanItemView = Omit<PlanItemRecord, 'workspaceId'>

export interface CreatePlanItemInput {
  readonly targetType: PipelineKind
  readonly targetId: string
  /** `YYYY-MM-DD`. Validated as a real calendar date at the boundary. */
  readonly date: string
  readonly title: string
  /**
   * Absent means unassigned, which is what the panel's own form offers. Unlike a
   * Deal, a plan item does not acquire the caller as its owner: writing down what
   * has to happen is not the same as volunteering to do it.
   */
  readonly ownerId: string | null
  readonly status: PlanItemStatus
}

/** PATCH semantics: an absent field is left alone, and null clears the owner. */
export interface UpdatePlanItemInput {
  readonly date?: string | undefined
  readonly title?: string | undefined
  readonly ownerId?: string | null | undefined
  readonly status?: PlanItemStatus | undefined
}

export interface PlansService {
  list(
    actor: Actor,
    filters: PlanItemFilters,
    query: ListQueryParameters,
  ): Promise<Page<PlanItemView>>
  get(actor: Actor, id: string): Promise<PlanItemView>
  create(actor: Actor, input: CreatePlanItemInput): Promise<PlanItemView>
  update(actor: Actor, id: string, changes: UpdatePlanItemInput): Promise<PlanItemView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: PlanItemRecord): PlanItemView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createPlansService(dependencies: PlansDependencies): PlansService {
  async function require(workspaceId: string, id: string): Promise<PlanItemRecord> {
    const item = await repository.findPlanItem(dependencies.db, workspaceId, id)

    // A plan item in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (item === undefined) {
      throw AppError.notFound('Plan item not found')
    }

    return item
  }

  async function requireTarget(
    workspaceId: string,
    targetType: PipelineKind,
    targetId: string,
  ): Promise<void> {
    if (!(await targetExists(dependencies.db, workspaceId, targetType, targetId))) {
      throw AppError.notFound('Record not found')
    }
  }

  async function requireOwner(workspaceId: string, ownerId: string): Promise<void> {
    if (!(await repository.memberExists(dependencies.db, workspaceId, ownerId))) {
      throw AppError.notFound('Team member not found')
    }
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, PLAN_ITEM_SORTS, DEFAULT_PLAN_ITEM_SORT)
      const rows = await repository.listPlanItems(dependencies.db, workspaceId, filters, window)

      return mapPage(
        toPage(rows, window, (item) => item.id),
        toView,
      )
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireTarget(workspaceId, input.targetType, input.targetId)

      if (input.ownerId !== null) {
        await requireOwner(workspaceId, input.ownerId)
      }

      const id = dependencies.createId('planItem')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertPlanItem(tx, {
          id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          date: input.date,
          title: input.title,
          ownerId: input.ownerId,
          status: input.status,
        })

        // The event fires whenever an item enters `done`, including one recorded
        // as already finished. A consumer watching for completed work cares that
        // the work is done, not whether it passed through `todo` on the way.
        if (created.status === 'done') {
          events.emit(
            'plans.plan_item.completed',
            { type: created.targetType, id: created.targetId },
            { planItemId: created.id },
          )
        }

        return toView(created)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const columns: Partial<repository.PlanItemColumns> = {
        ...(changes.date === undefined ? {} : { date: changes.date }),
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.ownerId === undefined ? {} : { ownerId: changes.ownerId }),
        ...(changes.status === undefined ? {} : { status: changes.status }),
      }
      const changed = changedKeys(existing, columns)

      // A PATCH that changes nothing is not a write. Bumping `updated_at` for it
      // would make the item look freshly touched to anything sorting by it.
      if (changed.length === 0) {
        return toView(existing)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        const updated = await repository.updatePlanItem(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Plan item not found')
        }

        // On the transition only. Re-sending `done` on a finished item changes
        // nothing, and it is caught above before it reaches here.
        if (changed.includes('status') && updated.status === 'done') {
          events.emit(
            'plans.plan_item.completed',
            { type: updated.targetType, id: updated.targetId },
            { planItemId: updated.id },
          )
        }

        return toView(updated)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      // No event. The catalog has `plan.completed` and nothing for a plan item
      // going away, and inventing a name here would be one the webhooks engine
      // has never been told about.
      await dependencies.transaction(async ({ tx }) => {
        await require(workspaceId, id)
        await repository.deletePlanItem(tx, workspaceId, id)
      })
    },
  }
}

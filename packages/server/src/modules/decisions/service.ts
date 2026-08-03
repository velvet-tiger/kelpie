import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import { targetExists } from '../recordTargets.ts'
import type { RecordTargetType } from '../recordTargets.ts'
import * as repository from './repository.ts'
import { DECISION_SORTS, DEFAULT_DECISION_SORT } from './repository.ts'
import type { DecisionFilters, DecisionRecord } from './repository.ts'

/**
 * Decisions: what the workspace decided or promised, kept queryable so agents
 * can read the commitments they must not contradict.
 *
 * The target is polymorphic and has no foreign key, so this service is what
 * refuses a decision attached to an id that does not exist or belongs to
 * another workspace. Nothing in the database would.
 *
 * No activity rows. `ACTIVITY_KINDS` carries nothing that describes a decision,
 * and filing one under `updated` would put a sentence on a timeline about a
 * record the timeline is not for. Adding a kind is a check-constraint migration
 * and belongs to whichever feature decides decision history is worth keeping.
 */

export interface DecisionsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
}

/** A decision as the API returns one: the stored row minus the tenancy column. */
export type DecisionView = Omit<DecisionRecord, 'workspaceId'>

export interface CreateDecisionInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly rationale: string | null
  /** Absent means now: most decisions are recorded as they are made. */
  readonly decidedAt: Date | undefined
  /**
   * Absent means the caller, like a Deal: the mockup's panel files the decision
   * under whoever recorded it. Null means nobody carries the commitment. A
   * workspace API key has no member, so its absent owner is null too.
   */
  readonly ownerId: string | null | undefined
  readonly dueAt: Date | null
}

/** PATCH semantics: an absent field is left alone. The target never moves. */
export interface UpdateDecisionInput {
  readonly body?: string | undefined
  readonly rationale?: string | null | undefined
  readonly decidedAt?: Date | undefined
  readonly ownerId?: string | null | undefined
  readonly dueAt?: Date | null | undefined
}

export interface DecisionsService {
  list(
    actor: Actor,
    filters: DecisionFilters,
    query: ListQueryParameters,
  ): Promise<Page<DecisionView>>
  get(actor: Actor, id: string): Promise<DecisionView>
  create(actor: Actor, input: CreateDecisionInput): Promise<DecisionView>
  update(actor: Actor, id: string, changes: UpdateDecisionInput): Promise<DecisionView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: DecisionRecord): DecisionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createDecisionsService(dependencies: DecisionsDependencies): DecisionsService {
  async function require(workspaceId: string, id: string): Promise<DecisionRecord> {
    const decision = await repository.findDecision(dependencies.db, workspaceId, id)

    // A decision in another workspace is indistinguishable from one that never
    // existed, per `api.md`.
    if (decision === undefined) {
      throw AppError.notFound('Decision not found')
    }

    return decision
  }

  async function requireTarget(
    workspaceId: string,
    targetType: RecordTargetType,
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
    // No target check here, unlike notes: this list is a workspace list first,
    // and a filter naming an id that matches nothing answers with an empty
    // page, the same as any other filter.
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, DECISION_SORTS, DEFAULT_DECISION_SORT)
      const rows = await repository.listDecisions(dependencies.db, workspaceId, filters, window)

      return mapPage(
        toPage(rows, window, (decision) => decision.id),
        toView,
      )
    },

    async get(actor, id) {
      return toView(await require(requireWorkspaceId(actor), id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireTarget(workspaceId, input.targetType, input.targetId)

      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const id = dependencies.createId('decision')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertDecision(tx, {
          id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          body: input.body,
          rationale: input.rationale,
          decidedAt: input.decidedAt ?? dependencies.now(),
          ownerId,
          dueAt: input.dueAt,
        })

        // `decision.added` rather than `record.created`: the catalog gives
        // decisions their own event, carrying the target, because a consumer
        // watching a record wants the commitment without a second lookup to
        // find out what it is attached to.
        events.emit('decision.added', {
          workspaceId,
          decisionId: created.id,
          targetType: created.targetType,
          targetId: created.targetId,
        })

        return toView(created)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const columns: Partial<repository.DecisionColumns> = {
        ...(changes.body === undefined ? {} : { body: changes.body }),
        ...(changes.rationale === undefined ? {} : { rationale: changes.rationale }),
        ...(changes.decidedAt === undefined ? {} : { decidedAt: changes.decidedAt }),
        ...(changes.ownerId === undefined ? {} : { ownerId: changes.ownerId }),
        ...(changes.dueAt === undefined ? {} : { dueAt: changes.dueAt }),
      }
      const changed = changedKeys(existing, columns)

      // A PATCH that changes nothing is not a write. Bumping `updated_at` for it
      // would make the decision look freshly touched to anything sorting by it.
      if (changed.length === 0) {
        return toView(existing)
      }

      // No event. The catalog carries `decision.added` and nothing for a
      // decision changing, and inventing a name here would add one the webhooks
      // engine has never been told about.
      return dependencies.transaction(async ({ tx }) => {
        const updated = await repository.updateDecision(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Decision not found')
        }

        return toView(updated)
      })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      // No event, for the same reason an update has none. A withdrawn
      // commitment simply stops being listable.
      await dependencies.transaction(async ({ tx }) => {
        await require(workspaceId, id)
        await repository.deleteDecision(tx, workspaceId, id)
      })
    },
  }
}

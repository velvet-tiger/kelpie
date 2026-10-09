import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { mapPage, readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import { toEventActor } from '../../lib/actor.ts'
import { hasApiKeyScope } from '../../lib/apiKeyScopes.ts'
import type { Actor } from '../auth/actor.ts'
import {
  actorMemberId,
  isAiAuthor,
  originAfterTextEdit,
  requireSessionActor,
  requireWorkspaceId,
  writeOrigin,
} from '../auth/actor.ts'
import './events.ts'
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
 *
 * A decision is a commitment only when `confirmedAt` is set. Who can write
 * one that is confirmed at once is `commitsDecisions`: a signed-in member, and
 * an API key or an OAuth token that holds `decisions:commit`. Every other
 * caller writes a proposal, and a member confirms it. No update confirms one;
 * `confirm` is the only way, and it takes a session.
 *
 * The same rule guards the text of a commitment. A caller that cannot commit
 * cannot change the `body` or the `rationale` of a confirmed decision: the
 * update is refused, and the caller proposes a new decision instead. So no
 * write takes a confirmation off, and a confirmed decision always holds text
 * that a member, or a credential trusted to commit, put there.
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

/** What the caller read before it confirmed. */
export interface ConfirmExpectation {
  /**
   * The `updated_at` of the proposal the member read, to the millisecond the
   * wire carries. Undefined confirms whatever is there now.
   */
  readonly updatedAt: Date | undefined
}

export interface DecisionsService {
  list(
    actor: Actor,
    filters: DecisionFilters,
    query: ListQueryParameters,
  ): Promise<Page<DecisionView>>
  get(actor: Actor, id: string): Promise<DecisionView>
  create(actor: Actor, input: CreateDecisionInput): Promise<DecisionView>
  /**
   * @throws AppError 403 when the caller cannot commit decisions and the
   *   change is to the `body` or the `rationale` of a confirmed decision.
   *   Nothing is written.
   */
  update(actor: Actor, id: string, changes: UpdateDecisionInput): Promise<DecisionView>
  /**
   * Turns a proposal into a commitment. Confirming a decision that is
   * confirmed already changes nothing and answers with it.
   *
   * @throws AppError 403 for every caller that is not a signed-in member: an
   *   API key, an OAuth token and the hosted AI.
   * @throws AppError 404 when the decision is not in the caller's workspace.
   * @throws AppError 409 when `expected.updatedAt` is given and the proposal
   *   was edited after that time. The member confirms the text they read, and
   *   not one an agent put there between the read and the click.
   */
  confirm(actor: Actor, id: string, expected: ConfirmExpectation): Promise<DecisionView>
  remove(actor: Actor, id: string): Promise<void>
}

/**
 * True when a decision this caller writes is a commitment without a member
 * confirming it.
 *
 * The model mark is read first. The hosted AI actor has the shape of an API
 * key with an empty scope list, and an empty list on a key means every scope,
 * so a scope check alone would let a run commit. A session marked for one
 * write of a model's text is refused here for the same reason.
 */
function commitsDecisions(actor: Actor): boolean {
  if (isAiAuthor(actor)) {
    return false
  }

  return hasApiKeyScope(actor, 'decisions:commit')
}

function sameMoment(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime()
}

/**
 * The columns of a PATCH whose value differs from the stored row, and only
 * those. An absent field is left alone. Text is compared exactly: a
 * difference in white space alone is a change.
 *
 * Exported for its unit test only.
 */
export function changedColumns(
  stored: DecisionRecord,
  changes: UpdateDecisionInput,
): Partial<repository.DecisionColumns> {
  return {
    ...(changes.body === undefined || changes.body === stored.body ? {} : { body: changes.body }),
    ...(changes.rationale === undefined || changes.rationale === stored.rationale
      ? {}
      : { rationale: changes.rationale }),
    ...(changes.decidedAt === undefined || sameMoment(changes.decidedAt, stored.decidedAt)
      ? {}
      : { decidedAt: changes.decidedAt }),
    ...(changes.ownerId === undefined || changes.ownerId === stored.ownerId ? {} : { ownerId: changes.ownerId }),
    ...(changes.dueAt === undefined || sameMoment(changes.dueAt, stored.dueAt) ? {} : { dueAt: changes.dueAt }),
  }
}

function toView(record: DecisionRecord): DecisionView {
  const { workspaceId: _workspaceId, ...view } = record

  return view
}

export function createDecisionsService(dependencies: DecisionsDependencies): DecisionsService {
  async function require(workspaceId: string, id: string): Promise<DecisionRecord> {
    const decision = await repository.findDecision(dependencies.db, workspaceId, id)

    // A decision in another workspace is indistinguishable from one that never
    // existed.
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
      const origin = writeOrigin(actor)
      const now = dependencies.now()
      // A decision from a caller that cannot commit waits for a member. A
      // member's own decision names that member; an agent's that is confirmed
      // as it is written names nobody, because no person looked at it.
      const confirmedAt = commitsDecisions(actor) ? now : null
      const confirmedById = origin === 'member' ? actorMemberId(actor) : null

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertDecision(tx, {
          id,
          workspaceId,
          targetType: input.targetType,
          targetId: input.targetId,
          body: input.body,
          rationale: input.rationale,
          decidedAt: input.decidedAt ?? now,
          ownerId,
          dueAt: input.dueAt,
          origin,
          confirmedAt,
          confirmedById,
        })

        // `decision.added` rather than `record.created`: the catalog gives
        // decisions their own event, carrying the target, because a consumer
        // watching a record wants the commitment without a second lookup to
        // find out what it is attached to.
        events.emit(
          'decisions.decision.added',
          { type: created.targetType, id: created.targetId },
          { decisionId: created.id, origin: created.origin, confirmed: created.confirmedAt !== null },
        )

        return toView(created)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)

      // No event. The catalog carries `decision.added` and nothing for a
      // decision changing, and inventing a name here would add one the webhooks
      // engine has never been told about.
      return dependencies.transaction(async ({ tx }) => {
        // The row is read once, here, with a lock that holds until the write
        // below is committed. Everything that follows is decided from it: what
        // the request changes, whether the text is a commitment's, and what is
        // written. A row read before the transaction can be older than the
        // one this write lands on. A member can confirm in between, or change
        // the text; a request that sends the text it read would then put the
        // old text back, under that member's confirmation. A confirm and
        // another update both wait for the lock.
        const stored = await repository.lockDecision(tx, workspaceId, id)

        // A decision in another workspace is indistinguishable from one that
        // never existed.
        if (stored === undefined) {
          throw AppError.notFound('Decision not found')
        }

        // Only the columns whose value differs from the locked row. A value
        // the request sent that is the stored one is not written again.
        const columns = changedColumns(stored, changes)

        // A PATCH that changes nothing is not a write. Bumping `updated_at` for it
        // would make the decision look freshly touched to anything sorting by it.
        if (Object.keys(columns).length === 0) {
          return toView(stored)
        }

        if (typeof columns.ownerId === 'string') {
          await requireOwner(workspaceId, columns.ownerId)
        }

        // A caller that is not a member and changes what the decision says
        // takes the member's name off it. The origin drops to the caller's, and
        // the member who confirmed the old text did not confirm this one.
        // `confirmedAt` is not touched here: no edit confirms a decision, and
        // none takes a confirmation off.
        const textChanged = columns.body !== undefined || columns.rationale !== undefined
        const rewritten = textChanged && writeOrigin(actor) !== 'member'

        // A caller that cannot commit may rewrite a proposal and may not
        // rewrite a commitment. The whole request is refused, also the fields
        // of it that are not text: a request is one change, and half of one
        // is not what the caller asked for.
        if (rewritten && !commitsDecisions(actor) && stored.confirmedAt !== null) {
          throw new AppError(
            'forbidden',
            'This decision is confirmed, and this connection cannot change its text. ' +
              'Create a new decision instead. It will be a proposal for a member to confirm',
          )
        }

        const updated = await repository.updateDecision(tx, workspaceId, id, {
          ...columns,
          ...(rewritten ? { origin: originAfterTextEdit(stored.origin, actor), confirmedById: null } : {}),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Decision not found')
        }

        return toView(updated)
      })
    },

    async confirm(actor, id, expected) {
      // Before the lookup, so a bearer caller learns nothing about which ids
      // exist. The hosted AI actor has the kind of an API key, so the session
      // check refuses it. An actor marked for one write of a model's text can
      // have the kind of a session, so it is refused by name.
      if (isAiAuthor(actor)) {
        throw new AppError('forbidden', 'Only a signed-in member can confirm a decision')
      }

      const session = requireSessionActor(actor)
      const workspaceId = requireWorkspaceId(session)
      const memberId = actorMemberId(session)

      if (memberId === null) {
        throw new AppError('forbidden', 'Only a member of this workspace can confirm a decision')
      }

      const existing = await require(workspaceId, id)

      // Before the version check, so the call stays safe to repeat: the
      // first confirm moved `updated_at`, and a retry still holds the old one.
      if (existing.confirmedAt !== null) {
        return toView(existing)
      }

      const now = dependencies.now()

      return dependencies.transaction(async ({ tx, events }) => {
        const confirmed = await repository.confirmDecision(
          tx,
          workspaceId,
          id,
          { confirmedAt: now, confirmedById: memberId, updatedAt: now },
          expected.updatedAt,
        )

        if (confirmed !== undefined) {
          events.emit(
            'decisions.decision.confirmed',
            { type: confirmed.targetType, id: confirmed.targetId },
            { decisionId: confirmed.id, origin: confirmed.origin },
          )

          return toView(confirmed)
        }

        // Nothing was written. Another request confirmed it or removed it
        // after the read above, or it is not the version the member read.
        const current = await repository.findDecision(tx, workspaceId, id)

        if (current === undefined) {
          throw AppError.notFound('Decision not found')
        }

        if (current.confirmedAt !== null) {
          return toView(current)
        }

        throw AppError.conflict('The decision changed after you read it. Read it again, then confirm it.')
      }, { workspaceId, actor: toEventActor(actor) })
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

import { changedKeys } from '../../lib/changes.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import type { IdFactory } from '../../lib/ids.ts'
import { readListWindow, toPage } from '../../lib/pagination.ts'
import type { ListQueryParameters, Page } from '../../lib/pagination.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import {
  describeCreation,
  describeLink,
  describeStageChange,
  describeUnlink,
  describeUpdate,
} from '../activities/wording.ts'
import type { FieldLabels } from '../activities/wording.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import * as companyRepository from '../companies/repository.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import type { PipelineStageRecord } from '../pipelines/repository.ts'
import * as repository from './repository.ts'
import { DEFAULT_RAISE_SORT, RAISE_SORTS } from './repository.ts'
import type { RaiseFilters, RaiseRecord } from './repository.ts'

/**
 * Raises: one fundraising process per firm per round, ending at closed or
 * passed. The firm is `company_id`; the ongoing relationship with that firm
 * stays a Partnership (`brief.md`).
 *
 * Key people attach through `raise_people` and appear as `person_ids` on the
 * wire, and the check size is integer cents plus an ISO 4217 code, both the
 * Deals mechanics. A stage move is an ordinary PATCH of `stage_id`, and it is
 * the one change that files a `stage_changed` activity and a `stage.changed`
 * event instead of the generic update pair.
 */

export interface RaisesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
}

/** What a changed column is called on a timeline. The mockup says Firm and Target close, not Company and Expected close. */
const RAISE_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  companyId: 'Firm',
  checkSizeCents: 'Check size',
  currency: 'Currency',
  thesisFit: 'Thesis fit',
  passReason: 'Pass reason',
  ownerId: 'Owner',
  expectedClose: 'Target close',
  summary: 'Summary',
  tags: 'Tags',
}

/** A raise as the API returns one: the stored row minus tenancy, plus its people. */
export type RaiseView = Omit<RaiseRecord, 'workspaceId'> & {
  readonly personIds: readonly string[]
}

export interface CreateRaiseInput {
  readonly name: string
  readonly companyId: string
  /** Absent means the pipeline's default stage: the first open one. */
  readonly stageId: string | undefined
  readonly checkSizeCents: number | null
  readonly currency: string | null
  readonly thesisFit: string
  /**
   * Null until they say no. Not gated on the passed stage: the mockup keeps a
   * recorded reason visible wherever the raise sits, so the API stores it the
   * same way.
   */
  readonly passReason: string | null
  /** Absent means the caller: the member creating a raise starts as its owner. */
  readonly ownerId: string | null | undefined
  /**
   * Null rather than the mockup's invented today; a fabricated close date is
   * worse than an absent one for agents.
   */
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateRaiseInput {
  readonly name?: string | undefined
  readonly companyId?: string | undefined
  readonly stageId?: string | undefined
  readonly checkSizeCents?: number | null | undefined
  readonly currency?: string | null | undefined
  readonly thesisFit?: string | undefined
  readonly passReason?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedClose?: string | null | undefined
  /** Replaces the set. The service works out who was added and who left. */
  readonly personIds?: readonly string[] | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
}

export interface RaisesService {
  list(actor: Actor, filters: RaiseFilters, query: ListQueryParameters): Promise<Page<RaiseView>>
  get(actor: Actor, id: string): Promise<RaiseView>
  create(actor: Actor, input: CreateRaiseInput): Promise<RaiseView>
  update(actor: Actor, id: string, changes: UpdateRaiseInput): Promise<RaiseView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: RaiseRecord, personIds: readonly string[]): RaiseView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, personIds }
}

function toStoredColumns(input: UpdateRaiseInput): Partial<repository.RaiseColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.checkSizeCents === undefined ? {} : { checkSizeCents: input.checkSizeCents }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.thesisFit === undefined ? {} : { thesisFit: input.thesisFit }),
    ...(input.passReason === undefined ? {} : { passReason: input.passReason }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.expectedClose === undefined ? {} : { expectedClose: input.expectedClose }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  }
}

export function createRaisesService(dependencies: RaisesDependencies): RaisesService {
  async function require(workspaceId: string, id: string): Promise<RaiseRecord> {
    const raise = await repository.findRaise(dependencies.db, workspaceId, id)

    if (raise === undefined) {
      throw AppError.notFound('Raise not found')
    }

    return raise
  }

  async function requireCompany(workspaceId: string, companyId: string): Promise<void> {
    const company = await companyRepository.findCompany(dependencies.db, workspaceId, companyId)

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  /**
   * A stage a raise may sit in: exists in this workspace and belongs to the
   * raise pipeline. The wrong-workspace case reads as missing, per `api.md`;
   * the wrong-pipeline case is a request naming a real stage that can never
   * hold a raise, which is a validation error rather than a missing record.
   */
  async function requireRaiseStage(
    workspaceId: string,
    stageId: string,
  ): Promise<PipelineStageRecord> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'raise') {
      throw AppError.validationFailed('That stage is not part of the raise pipeline', [
        { field: 'stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }

    return stage
  }

  /** The default stage for a new raise: the first open one, or the first if none are open. */
  async function defaultRaiseStage(workspaceId: string): Promise<PipelineStageRecord> {
    const rows = await pipelineRepository.listStagesOfKind(dependencies.db, workspaceId, 'raise')
    const first = rows.find((row) => row.open) ?? rows[0]

    if (first === undefined) {
      // Unreachable through the API: workspaces seed stages and the last stage
      // of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no raise stages')
    }

    return first
  }

  async function requireOwner(workspaceId: string, ownerId: string): Promise<void> {
    if (!(await repository.memberExists(dependencies.db, workspaceId, ownerId))) {
      throw AppError.notFound('Team member not found')
    }
  }

  /** @returns Each person's name, for the link activities. Any id missing here is a 404. */
  async function requirePeople(
    workspaceId: string,
    personIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const named = await repository.findPeopleNamed(dependencies.db, workspaceId, personIds)
    const missing = personIds.filter((id) => !named.has(id))

    if (missing.length > 0) {
      throw new AppError(
        'not_found',
        'Person not found',
        missing.map((id) => ({ field: 'person_ids', message: `No person ${id} here` })),
      )
    }

    return named
  }

  /** @returns The page's views, with every raise's people fetched in one query. */
  async function toViews(records: readonly RaiseRecord[]): Promise<RaiseView[]> {
    const peopleByRaise = await repository.listPersonIdsFor(
      dependencies.db,
      records.map((record) => record.id),
    )

    return records.map((record) => toView(record, peopleByRaise.get(record.id) ?? []))
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, RAISE_SORTS, DEFAULT_RAISE_SORT)
      const rows = await repository.listRaises(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (raise) => raise.id)

      return { items: await toViews(page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const raise = await require(workspaceId, id)

      return toView(raise, await repository.listPersonIds(dependencies.db, id))
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireCompany(workspaceId, input.companyId)

      const stage =
        input.stageId === undefined
          ? await defaultRaiseStage(workspaceId)
          : await requireRaiseStage(workspaceId, input.stageId)
      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const personIds = [...new Set(input.personIds)]
      const named = await requirePeople(workspaceId, personIds)
      const id = dependencies.createId('raise')

      return dependencies.transaction(async ({ tx, events }) => {
        const created = await repository.insertRaise(tx, {
          id,
          workspaceId,
          name: input.name,
          companyId: input.companyId,
          stageId: stage.id,
          checkSizeCents: input.checkSizeCents,
          currency: input.currency,
          thesisFit: input.thesisFit,
          passReason: input.passReason,
          ownerId,
          expectedClose: input.expectedClose,
          summary: input.summary,
          tags: [...input.tags],
        })

        await repository.insertRaisePeople(tx, id, personIds)

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'raise',
          targetId: id,
          kind: 'created',
          ...describeCreation('Raise'),
        })

        // One row per person, so the timeline names who was on it from day one.
        for (const personId of personIds) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'raise',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('record.created', { workspaceId, objectType: 'raise', recordId: id })

        return toView(created, personIds)
      })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (changes.companyId !== undefined && changes.companyId !== existing.companyId) {
        await requireCompany(workspaceId, changes.companyId)
      }

      const stageMove =
        changes.stageId === undefined || changes.stageId === existing.stageId
          ? undefined
          : {
              from: await requireRaiseStage(workspaceId, existing.stageId),
              to: await requireRaiseStage(workspaceId, changes.stageId),
            }

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const currentPeople = await repository.listPersonIds(dependencies.db, id)
      const nextPeople =
        changes.personIds === undefined ? undefined : [...new Set(changes.personIds)]
      const added =
        nextPeople === undefined
          ? []
          : nextPeople.filter((personId) => !currentPeople.includes(personId))
      const removed =
        nextPeople === undefined
          ? []
          : currentPeople.filter((personId) => !nextPeople.includes(personId))
      const named = await requirePeople(workspaceId, [...added, ...removed])

      const columns = toStoredColumns(changes)
      const changed = changedKeys(existing, columns)
      const linksChanged = added.length > 0 || removed.length > 0

      if (changed.length === 0 && !linksChanged) {
        return toView(existing, currentPeople)
      }

      return dependencies.transaction(async ({ tx, events }) => {
        const updated = await repository.updateRaise(tx, workspaceId, id, {
          ...columns,
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Raise not found')
        }

        await repository.insertRaisePeople(tx, id, added)
        await repository.deleteRaisePeople(tx, id, removed)

        if (stageMove !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'raise',
            targetId: id,
            kind: 'stage_changed',
            ...describeStageChange(stageMove.from.label, stageMove.to.label),
          })
        }

        const otherChanged = changed.filter((field) => field !== 'stageId')

        if (otherChanged.length > 0) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'raise',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(otherChanged, RAISE_FIELD_LABELS, existing, columns),
          })
        }

        // Links land on the raise's timeline only. A person's page does not roll
        // up raise activity — the mockup's roll-up for a person is deals and
        // partnerships — so this is where the row is read from a related page too.
        for (const personId of added) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'raise',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        for (const personId of removed) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'raise',
            targetId: id,
            kind: 'unlinked',
            ...describeUnlink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('record.updated', {
          workspaceId,
          objectType: 'raise',
          recordId: id,
          changedFields: linksChanged ? [...changed, 'personIds'] : changed,
        })

        if (stageMove !== undefined) {
          events.emit('stage.changed', {
            workspaceId,
            objectType: 'raise',
            recordId: id,
            fromStageId: stageMove.from.id,
            toStageId: stageMove.to.id,
          })
        }

        return toView(updated, nextPeople ?? currentPeople)
      })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        await require(workspaceId, id)

        // `raise_people` dies with the raise through its foreign key; notes,
        // activities, decisions and plan items have no key, so they are removed
        // here, in the same transaction.
        await deleteRecordsAttachedTo(tx, workspaceId, 'raise', id)
        await repository.deleteRaise(tx, workspaceId, id)

        events.emit('record.deleted', { workspaceId, objectType: 'raise', recordId: id })
      })
    },
  }
}

import type { CustomFieldWireValue } from '@kelpie/schemas'

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
import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { actorMemberId, requireWorkspaceId } from '../auth/actor.ts'
import './events.ts'
import { deleteRecordsAttachedTo } from '../attachedRecords.ts'
import { clearConversionPointersToTarget } from '../conversions/clearPointers.ts'
import * as companyRepository from '../companies/repository.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import * as personLinks from '../personLinks.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import type { PipelineStageRecord } from '../pipelines/repository.ts'
import * as repository from './repository.ts'
import { DEFAULT_PARTNERSHIP_SORT, PARTNERSHIP_SORTS } from './repository.ts'
import type { PartnershipFilters, PartnershipRecord } from './repository.ts'

/**
 * Partnerships: ongoing two-way relationships. Status is a stage of the
 * `partnership` pipeline; there is no favour ledger (`brief.md` non-goal).
 *
 * Key people attach through `person_links` and appear as `person_ids` on
 * the wire, the Deals mechanics; kind is free text, the Opportunities mechanics.
 * A stage move is an ordinary PATCH of `stage_id`, and it is the one change that
 * files a `stage_changed` activity and a `stage.changed` event instead of the
 * generic update pair.
 */

export interface PartnershipsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

/** What a changed column is called on a timeline. `successLooksLike` is why these are written out. */
const PARTNERSHIP_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  kind: 'Kind',
  companyId: 'Company',
  ownerId: 'Owner',
  nextTouchpoint: 'Next touchpoint',
  goals: 'Goals',
  successLooksLike: 'Success looks like',
  summary: 'Summary',
  tags: 'Tags',
}

/** A partnership as the API returns one: the stored row minus tenancy, plus its people. */
export type PartnershipView = Omit<PartnershipRecord, 'workspaceId'> & {
  readonly personIds: readonly string[]
}

export interface CreatePartnershipInput {
  readonly name: string
  readonly companyId: string
  /** Absent means the pipeline's default stage: the first open one. */
  readonly stageId: string | undefined
  /**
   * Free text. Empty means unclassified: the mockup's Add button invents
   * "Other", and a fabricated kind is worse than an absent one for agents.
   */
  readonly kind: string
  readonly nextTouchpoint: string | null
  /** Absent means the caller: the member creating a partnership starts as its owner. */
  readonly ownerId: string | null | undefined
  readonly goals: string
  readonly successLooksLike: string
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Wire shape for a create body: `null` values are ignored, non-null are validated. */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdatePartnershipInput {
  readonly name?: string | undefined
  readonly companyId?: string | undefined
  readonly stageId?: string | undefined
  readonly kind?: string | undefined
  readonly nextTouchpoint?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly goals?: string | undefined
  readonly successLooksLike?: string | undefined
  /** Replaces the set. The service works out who was added and who left. */
  readonly personIds?: readonly string[] | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
  /**
   * Partial merge patch (wire shape): sent keys change, `null` clears a key,
   * absent keys are left alone. Unknown keys are `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

export interface PartnershipsService {
  list(
    actor: Actor,
    filters: PartnershipFilters,
    query: ListQueryParameters,
  ): Promise<Page<PartnershipView>>
  get(actor: Actor, id: string): Promise<PartnershipView>
  create(actor: Actor, input: CreatePartnershipInput): Promise<PartnershipView>
  update(actor: Actor, id: string, changes: UpdatePartnershipInput): Promise<PartnershipView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: PartnershipRecord, personIds: readonly string[]): PartnershipView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, personIds }
}

function toStoredColumns(input: UpdatePartnershipInput): Partial<repository.PartnershipColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.nextTouchpoint === undefined ? {} : { nextTouchpoint: input.nextTouchpoint }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.goals === undefined ? {} : { goals: input.goals }),
    ...(input.successLooksLike === undefined ? {} : { successLooksLike: input.successLooksLike }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  }
}

export function createPartnershipsService(
  dependencies: PartnershipsDependencies,
): PartnershipsService {
  async function require(workspaceId: string, id: string): Promise<PartnershipRecord> {
    const partnership = await repository.findPartnership(dependencies.db, workspaceId, id)

    if (partnership === undefined) {
      throw AppError.notFound('Partnership not found')
    }

    return partnership
  }

  async function requireCompany(workspaceId: string, companyId: string): Promise<void> {
    const company = await companyRepository.findCompany(dependencies.db, workspaceId, companyId)

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  /**
   * A stage a partnership may sit in: exists in this workspace and belongs to
   * the partnership pipeline. The wrong-workspace case reads as missing, per
   * `api.md`; the wrong-pipeline case is a request naming a real stage that can
   * never hold a partnership, which is a validation error rather than a missing
   * record.
   */
  async function requirePartnershipStage(
    workspaceId: string,
    stageId: string,
  ): Promise<PipelineStageRecord> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'partnership') {
      throw AppError.validationFailed('That stage is not part of the partnership pipeline', [
        { field: 'stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }

    return stage
  }

  /** The default stage for a new partnership: the first open one, or the first if none are open. */
  async function defaultPartnershipStage(workspaceId: string): Promise<PipelineStageRecord> {
    const rows = await pipelineRepository.listStagesOfKind(
      dependencies.db,
      workspaceId,
      'partnership',
    )
    const first = rows.find((row) => row.open) ?? rows[0]

    if (first === undefined) {
      // Unreachable through the API: workspaces seed stages and the last stage
      // of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no partnership stages')
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
    const named = await personLinks.findPeopleNamed(dependencies.db, workspaceId, personIds)
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

  /** @returns The page's views, with every partnership's people fetched in one query. */
  async function toViews(
    workspaceId: string,
    records: readonly PartnershipRecord[],
  ): Promise<PartnershipView[]> {
    const peopleByPartnership = await personLinks.listPersonIdsFor(
      dependencies.db,
      workspaceId,
      'partnership',
      records.map((record) => record.id),
    )

    return records.map((record) => toView(record, peopleByPartnership.get(record.id) ?? []))
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, PARTNERSHIP_SORTS, DEFAULT_PARTNERSHIP_SORT)
      const rows = await repository.listPartnerships(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (partnership) => partnership.id)

      return { items: await toViews(workspaceId, page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const partnership = await require(workspaceId, id)

      return toView(
        partnership,
        await personLinks.listPersonIds(dependencies.db, workspaceId, {
          targetType: 'partnership',
          targetId: id,
        }),
      )
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireCompany(workspaceId, input.companyId)

      const stage =
        input.stageId === undefined
          ? await defaultPartnershipStage(workspaceId)
          : await requirePartnershipStage(workspaceId, input.stageId)
      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const personIds = [...new Set(input.personIds)]
      const named = await requirePeople(workspaceId, personIds)
      const id = dependencies.createId('partnership')

      return dependencies.transaction(async ({ tx, events }) => {
        const customFields = await dependencies.customFields.forCreate(
          tx,
          workspaceId,
          'partnership',
          input.customFields,
        )
        const created = await repository.insertPartnership(tx, {
          id,
          workspaceId,
          name: input.name,
          companyId: input.companyId,
          stageId: stage.id,
          kind: input.kind,
          nextTouchpoint: input.nextTouchpoint,
          ownerId,
          goals: input.goals,
          successLooksLike: input.successLooksLike,
          summary: input.summary,
          tags: [...input.tags],
          customFields,
        })

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'partnership', targetId: id },
          personIds,
        )

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'partnership',
          targetId: id,
          kind: 'created',
          ...describeCreation('Partnership'),
        })

        // One row per person, so the timeline names who was on it from day one.
        for (const personId of personIds) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'partnership',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('partnerships.partnership.created', { type: 'partnership', id }, {})

        return toView(created, personIds)
      }, { workspaceId, actor: toEventActor(actor) })
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
              from: await requirePartnershipStage(workspaceId, existing.stageId),
              to: await requirePartnershipStage(workspaceId, changes.stageId),
            }

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const currentPeople = await personLinks.listPersonIds(dependencies.db, workspaceId, {
        targetType: 'partnership',
        targetId: id,
      })
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
      const scalarChanged = changedKeys(existing, columns)
      const linksChanged = added.length > 0 || removed.length > 0

      return dependencies.transaction(async ({ tx, events }) => {
        const cf = await dependencies.customFields.forUpdate(
          tx,
          workspaceId,
          'partnership',
          existing.customFields,
          changes.customFields,
        )
        const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

        if (scalarChanged.length === 0 && !linksChanged && !customFieldsChanged) {
          return toView(existing, currentPeople)
        }

        const updated = await repository.updatePartnership(tx, workspaceId, id, {
          ...columns,
          ...(customFieldsChanged ? { customFields: cf.merged } : {}),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Partnership not found')
        }

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'partnership', targetId: id },
          added,
        )
        await personLinks.unlinkPeople(
          tx,
          workspaceId,
          { targetType: 'partnership', targetId: id },
          removed,
        )

        if (stageMove !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'partnership',
            targetId: id,
            kind: 'stage_changed',
            ...describeStageChange(stageMove.from.label, stageMove.to.label),
          })
        }

        const otherChanged = scalarChanged.filter((field) => field !== 'stageId')
        const customFieldPaths = cf?.changedPaths ?? []
        const activityChanged = [...otherChanged, ...customFieldPaths]

        if (activityChanged.length > 0) {
          const labels: Record<string, string> = { ...PARTNERSHIP_FIELD_LABELS, ...cf?.labels }
          const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
          const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'partnership',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(activityChanged, labels, before, after),
          })
        }

        // Links land on the partnership's timeline only: a person's page already
        // rolls up the activity of every partnership they are on, so a second row
        // targeted at the person would show them the same news twice.
        for (const personId of added) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'partnership',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        for (const personId of removed) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'partnership',
            targetId: id,
            kind: 'unlinked',
            ...describeUnlink('person', named.get(personId) ?? personId),
          })
        }

        events.emit(
          'partnerships.partnership.updated',
          { type: 'partnership', id },
          {
            changed: [
              ...scalarChanged,
              ...(linksChanged ? ['personIds'] : []),
              ...customFieldPaths,
            ],
          },
        )

        if (stageMove !== undefined) {
          events.emit(
            'partnerships.partnership.stage_changed',
            { type: 'partnership', id },
            { fromStageId: stageMove.from.id, toStageId: stageMove.to.id },
          )
        }

        return toView(updated, nextPeople ?? currentPeople)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async remove(actor, id) {
      const workspaceId = requireWorkspaceId(actor)

      await dependencies.transaction(async ({ tx, events }) => {
        await require(workspaceId, id)

        await clearConversionPointersToTarget(tx, workspaceId, 'partnership', id)

        // Notes, activities, decisions, plan items, and person_links have no
        // key back to the partnership, so they are removed here, in the same
        // transaction.
        await deleteRecordsAttachedTo(tx, workspaceId, 'partnership', id)
        await repository.deletePartnership(tx, workspaceId, id)

        events.emit('partnerships.partnership.deleted', { type: 'partnership', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

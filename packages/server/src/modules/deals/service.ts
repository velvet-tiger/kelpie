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
import { DEAL_SORTS, DEFAULT_DEAL_SORT } from './repository.ts'
import type { DealFilters, DealRecord } from './repository.ts'

/**
 * Deals: the sales pipeline, and the first of the four staged objects.
 *
 * People attach through `person_links` and appear as `person_ids` on the wire;
 * the polymorphic link table is a storage detail. A stage move is an ordinary PATCH of
 * `stage_id`, and it is the one change that files a `stage_changed` activity and
 * a `stage.changed` event instead of the generic update pair.
 */

export interface DealsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

/** What a changed column is called on a timeline. `whyWin` is why these are written out. */
const DEAL_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  companyId: 'Company',
  valueCents: 'Value',
  currency: 'Currency',
  ownerId: 'Owner',
  expectedClose: 'Expected close',
  competitors: 'Competitors',
  risks: 'Risks',
  whyWin: 'Why we win',
  summary: 'Summary',
  tags: 'Tags',
  externalId: 'External id',
}

/** A deal as the API returns one: the stored row minus tenancy, plus its people. */
export type DealView = Omit<DealRecord, 'workspaceId'> & { readonly personIds: readonly string[] }

export interface CreateDealInput {
  readonly name: string
  readonly companyId: string
  /** Absent means the pipeline's default stage: the first open one. */
  readonly stageId: string | undefined
  readonly valueCents: number | null
  readonly currency: string | null
  /** Absent means the caller: the member creating a deal starts as its owner. */
  readonly ownerId: string | null | undefined
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly competitors: readonly string[]
  readonly risks: string
  readonly whyWin: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly externalId: string | null
  /** Wire shape for a create body: `null` values are ignored, non-null are validated. */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateDealInput {
  readonly name?: string | undefined
  readonly companyId?: string | undefined
  readonly stageId?: string | undefined
  readonly valueCents?: number | null | undefined
  readonly currency?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedClose?: string | null | undefined
  /** Replaces the set. The service works out who was added and who left. */
  readonly personIds?: readonly string[] | undefined
  readonly competitors?: readonly string[] | undefined
  readonly risks?: string | undefined
  readonly whyWin?: string | undefined
  readonly summary?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly externalId?: string | null | undefined
  /**
   * Partial merge patch (wire shape): sent keys change, `null` clears a key,
   * absent keys are left alone. The whole object is undefined when the caller
   * sent nothing at all. Unknown keys are `422`.
   */
  readonly customFields?: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

export interface DealsService {
  list(actor: Actor, filters: DealFilters, query: ListQueryParameters): Promise<Page<DealView>>
  get(actor: Actor, id: string): Promise<DealView>
  create(actor: Actor, input: CreateDealInput): Promise<DealView>
  update(actor: Actor, id: string, changes: UpdateDealInput): Promise<DealView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: DealRecord, personIds: readonly string[]): DealView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, personIds }
}

function toStoredColumns(input: UpdateDealInput): Partial<repository.DealColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.valueCents === undefined ? {} : { valueCents: input.valueCents }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.expectedClose === undefined ? {} : { expectedClose: input.expectedClose }),
    ...(input.competitors === undefined ? {} : { competitors: [...input.competitors] }),
    ...(input.risks === undefined ? {} : { risks: input.risks }),
    ...(input.whyWin === undefined ? {} : { whyWin: input.whyWin }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
  }
}

export function createDealsService(dependencies: DealsDependencies): DealsService {
  async function require(workspaceId: string, id: string): Promise<DealRecord> {
    const deal = await repository.findDeal(dependencies.db, workspaceId, id)

    if (deal === undefined) {
      throw AppError.notFound('Deal not found')
    }

    return deal
  }

  async function requireCompany(workspaceId: string, companyId: string): Promise<void> {
    const company = await companyRepository.findCompany(dependencies.db, workspaceId, companyId)

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  /**
   * A stage a deal may sit in: exists in this workspace and belongs to the deal
   * pipeline. The wrong-workspace case reads as missing, per `api.md`; the
   * wrong-pipeline case is a request naming a real stage that can never hold a
   * deal, which is a validation error rather than a missing record.
   */
  async function requireDealStage(
    workspaceId: string,
    stageId: string,
  ): Promise<PipelineStageRecord> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'deal') {
      throw AppError.validationFailed('That stage is not part of the deal pipeline', [
        { field: 'stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }

    return stage
  }

  /** The default stage for a new deal: the first open one, or the first if none are open. */
  async function defaultDealStage(workspaceId: string): Promise<PipelineStageRecord> {
    const rows = await pipelineRepository.listStagesOfKind(dependencies.db, workspaceId, 'deal')
    const first = rows.find((row) => row.open) ?? rows[0]

    if (first === undefined) {
      // Unreachable through the API: workspaces seed stages and the last stage
      // of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no deal stages')
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

  /** @returns The page's views, with every deal's people fetched in one query. */
  async function toViews(workspaceId: string, records: readonly DealRecord[]): Promise<DealView[]> {
    const peopleByDeal = await personLinks.listPersonIdsFor(
      dependencies.db,
      workspaceId,
      'deal',
      records.map((record) => record.id),
    )

    return records.map((record) => toView(record, peopleByDeal.get(record.id) ?? []))
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, DEAL_SORTS, DEFAULT_DEAL_SORT)
      const rows = await repository.listDeals(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (deal) => deal.id)

      return { items: await toViews(workspaceId, page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const deal = await require(workspaceId, id)

      return toView(
        deal,
        await personLinks.listPersonIds(dependencies.db, workspaceId, {
          targetType: 'deal',
          targetId: id,
        }),
      )
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      await requireCompany(workspaceId, input.companyId)

      const stage =
        input.stageId === undefined
          ? await defaultDealStage(workspaceId)
          : await requireDealStage(workspaceId, input.stageId)
      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const personIds = [...new Set(input.personIds)]
      const named = await requirePeople(workspaceId, personIds)
      const id = dependencies.createId('deal')

      return dependencies.transaction(async ({ tx, events }) => {
        const customFields = await dependencies.customFields.forCreate(
          tx,
          workspaceId,
          'deal',
          input.customFields,
        )
        const created = await repository.insertDeal(tx, {
          id,
          workspaceId,
          name: input.name,
          companyId: input.companyId,
          stageId: stage.id,
          valueCents: input.valueCents,
          currency: input.currency,
          ownerId,
          expectedClose: input.expectedClose,
          competitors: [...input.competitors],
          risks: input.risks,
          whyWin: input.whyWin,
          summary: input.summary,
          tags: [...input.tags],
          externalId: input.externalId,
          customFields,
        })

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'deal', targetId: id },
          personIds,
        )

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'deal',
          targetId: id,
          kind: 'created',
          ...describeCreation('Deal'),
        })

        // One row per person, so the timeline names who was on it from day one.
        for (const personId of personIds) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'deal',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('deals.deal.created', { type: 'deal', id }, {})

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
              from: await requireDealStage(workspaceId, existing.stageId),
              to: await requireDealStage(workspaceId, changes.stageId),
            }

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const currentPeople = await personLinks.listPersonIds(dependencies.db, workspaceId, {
        targetType: 'deal',
        targetId: id,
      })
      const nextPeople = changes.personIds === undefined ? undefined : [...new Set(changes.personIds)]
      const added =
        nextPeople === undefined ? [] : nextPeople.filter((personId) => !currentPeople.includes(personId))
      const removed =
        nextPeople === undefined ? [] : currentPeople.filter((personId) => !nextPeople.includes(personId))
      const named = await requirePeople(workspaceId, [...added, ...removed])

      const columns = toStoredColumns(changes)
      const scalarChanged = changedKeys(existing, columns)
      const linksChanged = added.length > 0 || removed.length > 0

      return dependencies.transaction(async ({ tx, events }) => {
        const cf = await dependencies.customFields.forUpdate(
          tx,
          workspaceId,
          'deal',
          existing.customFields,
          changes.customFields,
        )
        const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

        if (scalarChanged.length === 0 && !linksChanged && !customFieldsChanged) {
          return toView(existing, currentPeople)
        }

        const updated = await repository.updateDeal(tx, workspaceId, id, {
          ...columns,
          ...(customFieldsChanged ? { customFields: cf.merged } : {}),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Deal not found')
        }

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'deal', targetId: id },
          added,
        )
        await personLinks.unlinkPeople(
          tx,
          workspaceId,
          { targetType: 'deal', targetId: id },
          removed,
        )

        if (stageMove !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'deal',
            targetId: id,
            kind: 'stage_changed',
            ...describeStageChange(stageMove.from.label, stageMove.to.label),
          })
        }

        const otherChanged = scalarChanged.filter((field) => field !== 'stageId')
        const customFieldPaths = cf?.changedPaths ?? []
        const activityChanged = [...otherChanged, ...customFieldPaths]

        if (activityChanged.length > 0) {
          const labels: Record<string, string> = { ...DEAL_FIELD_LABELS, ...cf?.labels }
          const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
          const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'deal',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(activityChanged, labels, before, after),
          })
        }

        // Links land on the deal's timeline only: a person's page already rolls
        // up the activity of every deal they are on, so a second row targeted at
        // the person would show them the same news twice.
        for (const personId of added) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'deal',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        for (const personId of removed) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'deal',
            targetId: id,
            kind: 'unlinked',
            ...describeUnlink('person', named.get(personId) ?? personId),
          })
        }

        events.emit(
          'deals.deal.updated',
          { type: 'deal', id },
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
            'deals.deal.stage_changed',
            { type: 'deal', id },
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

        await clearConversionPointersToTarget(tx, workspaceId, 'deal', id)

        // Form submissions unlink themselves through `set null`; notes,
        // activities, decisions, plan items, and person_links have no key back
        // to the deal, so they are removed here, in the same transaction.
        await deleteRecordsAttachedTo(tx, workspaceId, 'deal', id)
        await repository.deleteDeal(tx, workspaceId, id)

        events.emit('deals.deal.deleted', { type: 'deal', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

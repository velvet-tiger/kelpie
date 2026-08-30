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
import * as companyRepository from '../companies/repository.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import * as personLinks from '../personLinks.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import type { PipelineStageRecord } from '../pipelines/repository.ts'
import * as repository from './repository.ts'
import { DEFAULT_OPPORTUNITY_SORT, OPPORTUNITY_SORTS } from './repository.ts'
import type { OpportunityFilters, OpportunityRecord } from './repository.ts'

/**
 * Opportunities: the non-sales pipeline. Grants, accelerators, tenders, press,
 * speaking — same stage mechanics as Deals, different lens. People attach
 * through `person_links` and appear as `person_ids` on the wire, the same
 * shape deals/partnerships/raises use.
 *
 * A stage move is an ordinary PATCH of `stage_id`, and it is the one change that
 * files a `stage_changed` activity and a `stage.changed` event instead of the
 * generic update pair.
 */

export interface OpportunitiesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

/** What a changed column is called on a timeline. The mockup says "Target date", not "Expected close". */
const OPPORTUNITY_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  kind: 'Kind',
  companyId: 'Company',
  ownerId: 'Owner',
  expectedClose: 'Target date',
  summary: 'Summary',
  tags: 'Tags',
}

/** An opportunity as the API returns one: the stored row minus tenancy, plus its people. */
export type OpportunityView = Omit<OpportunityRecord, 'workspaceId'> & {
  readonly personIds: readonly string[]
}

export interface CreateOpportunityInput {
  readonly name: string
  /**
   * Free text. Empty means unclassified: the mockup's Add button invents
   * "Other", and a fabricated kind is worse than an absent one for agents.
   */
  readonly kind: string
  /** Absent means the pipeline's default stage: the first open one. */
  readonly stageId: string | undefined
  readonly companyId: string | null
  /** Absent means the caller: the member creating an opportunity starts as its owner. */
  readonly ownerId: string | null | undefined
  readonly expectedClose: string | null
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Wire shape for a create body: `null` values are ignored, non-null are validated. */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateOpportunityInput {
  readonly name?: string | undefined
  readonly kind?: string | undefined
  readonly stageId?: string | undefined
  readonly companyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedClose?: string | null | undefined
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

export interface OpportunitiesService {
  list(
    actor: Actor,
    filters: OpportunityFilters,
    query: ListQueryParameters,
  ): Promise<Page<OpportunityView>>
  get(actor: Actor, id: string): Promise<OpportunityView>
  create(actor: Actor, input: CreateOpportunityInput): Promise<OpportunityView>
  update(actor: Actor, id: string, changes: UpdateOpportunityInput): Promise<OpportunityView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: OpportunityRecord, personIds: readonly string[]): OpportunityView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, personIds }
}

function toStoredColumns(input: UpdateOpportunityInput): Partial<repository.OpportunityColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.expectedClose === undefined ? {} : { expectedClose: input.expectedClose }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  }
}

export function createOpportunitiesService(
  dependencies: OpportunitiesDependencies,
): OpportunitiesService {
  async function require(workspaceId: string, id: string): Promise<OpportunityRecord> {
    const opportunity = await repository.findOpportunity(dependencies.db, workspaceId, id)

    if (opportunity === undefined) {
      throw AppError.notFound('Opportunity not found')
    }

    return opportunity
  }

  async function requireCompany(workspaceId: string, companyId: string): Promise<void> {
    const company = await companyRepository.findCompany(dependencies.db, workspaceId, companyId)

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  /**
   * A stage an opportunity may sit in: exists in this workspace and belongs to
   * the opportunity pipeline. The wrong-workspace case reads as missing, per
   * `api.md`; the wrong-pipeline case is a request naming a real stage that can
   * never hold an opportunity, which is a validation error rather than a missing
   * record.
   */
  async function requireOpportunityStage(
    workspaceId: string,
    stageId: string,
  ): Promise<PipelineStageRecord> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'opportunity') {
      throw AppError.validationFailed('That stage is not part of the opportunity pipeline', [
        { field: 'stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }

    return stage
  }

  /** The default stage for a new opportunity: the first open one, or the first if none are open. */
  async function defaultOpportunityStage(workspaceId: string): Promise<PipelineStageRecord> {
    const rows = await pipelineRepository.listStagesOfKind(
      dependencies.db,
      workspaceId,
      'opportunity',
    )
    const first = rows.find((row) => row.open) ?? rows[0]

    if (first === undefined) {
      // Unreachable through the API: workspaces seed stages and the last stage
      // of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no opportunity stages')
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

  /** @returns The page's views, with every opportunity's people fetched in one query. */
  async function toViews(
    workspaceId: string,
    records: readonly OpportunityRecord[],
  ): Promise<OpportunityView[]> {
    const peopleByOpportunity = await personLinks.listPersonIdsFor(
      dependencies.db,
      workspaceId,
      'opportunity',
      records.map((record) => record.id),
    )

    return records.map((record) => toView(record, peopleByOpportunity.get(record.id) ?? []))
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, OPPORTUNITY_SORTS, DEFAULT_OPPORTUNITY_SORT)
      const rows = await repository.listOpportunities(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (opportunity) => opportunity.id)

      return { items: await toViews(workspaceId, page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const opportunity = await require(workspaceId, id)

      return toView(
        opportunity,
        await personLinks.listPersonIds(dependencies.db, workspaceId, {
          targetType: 'opportunity',
          targetId: id,
        }),
      )
    },

    async create(actor, input) {
      const workspaceId = requireWorkspaceId(actor)

      if (input.companyId !== null) {
        await requireCompany(workspaceId, input.companyId)
      }

      const stage =
        input.stageId === undefined
          ? await defaultOpportunityStage(workspaceId)
          : await requireOpportunityStage(workspaceId, input.stageId)
      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const personIds = [...new Set(input.personIds)]
      const named = await requirePeople(workspaceId, personIds)
      const id = dependencies.createId('opportunity')

      return dependencies.transaction(async ({ tx, events }) => {
        const customFields = await dependencies.customFields.forCreate(
          tx,
          workspaceId,
          'opportunity',
          input.customFields,
        )
        const created = await repository.insertOpportunity(tx, {
          id,
          workspaceId,
          name: input.name,
          kind: input.kind,
          stageId: stage.id,
          companyId: input.companyId,
          ownerId,
          expectedClose: input.expectedClose,
          summary: input.summary,
          tags: [...input.tags],
          customFields,
        })

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'opportunity', targetId: id },
          personIds,
        )

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'opportunity',
          targetId: id,
          kind: 'created',
          ...describeCreation('Opportunity'),
        })

        // One row per person, so the timeline names who was on it from day one.
        for (const personId of personIds) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'opportunity',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('opportunities.opportunity.created', { type: 'opportunity', id }, {})

        return toView(created, personIds)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (
        typeof changes.companyId === 'string' &&
        changes.companyId !== existing.companyId
      ) {
        await requireCompany(workspaceId, changes.companyId)
      }

      const stageMove =
        changes.stageId === undefined || changes.stageId === existing.stageId
          ? undefined
          : {
              from: await requireOpportunityStage(workspaceId, existing.stageId),
              to: await requireOpportunityStage(workspaceId, changes.stageId),
            }

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const currentPeople = await personLinks.listPersonIds(dependencies.db, workspaceId, {
        targetType: 'opportunity',
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
          'opportunity',
          existing.customFields,
          changes.customFields,
        )
        const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

        if (scalarChanged.length === 0 && !linksChanged && !customFieldsChanged) {
          return toView(existing, currentPeople)
        }

        const updated = await repository.updateOpportunity(tx, workspaceId, id, {
          ...columns,
          ...(customFieldsChanged ? { customFields: cf.merged } : {}),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Opportunity not found')
        }

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'opportunity', targetId: id },
          added,
        )
        await personLinks.unlinkPeople(
          tx,
          workspaceId,
          { targetType: 'opportunity', targetId: id },
          removed,
        )

        if (stageMove !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'opportunity',
            targetId: id,
            kind: 'stage_changed',
            ...describeStageChange(stageMove.from.label, stageMove.to.label),
          })
        }

        const otherChanged = scalarChanged.filter((field) => field !== 'stageId')
        const customFieldPaths = cf?.changedPaths ?? []
        const activityChanged = [...otherChanged, ...customFieldPaths]

        if (activityChanged.length > 0) {
          const labels: Record<string, string> = { ...OPPORTUNITY_FIELD_LABELS, ...cf?.labels }
          const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
          const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'opportunity',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(activityChanged, labels, before, after),
          })
        }

        // Links land on the opportunity's timeline only: a person's page already
        // rolls up the activity of every pipeline record they are on, so a
        // second row targeted at the person would show them the same news twice.
        for (const personId of added) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'opportunity',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        for (const personId of removed) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'opportunity',
            targetId: id,
            kind: 'unlinked',
            ...describeUnlink('person', named.get(personId) ?? personId),
          })
        }

        events.emit(
          'opportunities.opportunity.updated',
          { type: 'opportunity', id },
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
            'opportunities.opportunity.stage_changed',
            { type: 'opportunity', id },
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

        // Notes, activities, decisions, plan items, and person_links have no
        // foreign key to their target, so the deleting service removes them
        // here, in the same transaction. Nothing else references an opportunity.
        await deleteRecordsAttachedTo(tx, workspaceId, 'opportunity', id)
        await repository.deleteOpportunity(tx, workspaceId, id)

        events.emit('opportunities.opportunity.deleted', { type: 'opportunity', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

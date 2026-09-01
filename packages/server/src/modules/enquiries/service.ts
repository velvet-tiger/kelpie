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
import { DEFAULT_ENQUIRY_SORT, ENQUIRY_SORTS } from './repository.ts'
import type { EnquiryFilters, EnquiryRecord } from './repository.ts'

/**
 * Enquiries: the top-of-funnel pipeline. Inbound requests that may become a
 * Deal once qualified. People attach through `person_links`; company is
 * optional (some enquiries arrive before a company is on file).
 *
 * A stage move is an ordinary PATCH of `stage_id`, and it is the one change
 * that files a `stage_changed` activity and a `stage.changed` event instead of
 * the generic update pair.
 *
 * The one non-CRUD action is `convertToDeal`, which is what
 * `POST /v1/enquiries/:id/convert` calls: it inserts a new deal, copies the
 * enquiry's people to it, sets `convertedDealId`, and moves the enquiry to
 * its first closed stage.
 */

export interface EnquiriesDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

/** What a changed column is called on a timeline. */
const ENQUIRY_FIELD_LABELS: FieldLabels = {
  name: 'Name',
  source: 'Source',
  companyId: 'Company',
  ownerId: 'Owner',
  summary: 'Summary',
  tags: 'Tags',
}

/** An enquiry as the API returns one: the stored row minus tenancy, plus its people. */
export type EnquiryView = Omit<EnquiryRecord, 'workspaceId'> & {
  readonly personIds: readonly string[]
}

export interface CreateEnquiryInput {
  readonly name: string
  /** Free text ("Website", "Email", "Referral"). Empty means unclassified. */
  readonly source: string
  /** Absent means the pipeline's default stage: the first open one. */
  readonly stageId: string | undefined
  readonly companyId: string | null
  /** Absent means the caller: the member creating an enquiry starts as its owner. */
  readonly ownerId: string | null | undefined
  readonly personIds: readonly string[]
  readonly summary: string
  readonly tags: readonly string[]
  /** Wire shape for a create body: `null` values are ignored, non-null are validated. */
  readonly customFields: Readonly<Record<string, CustomFieldWireValue | null>> | undefined
}

/** PATCH semantics: an absent field is left alone, and null clears a nullable one. */
export interface UpdateEnquiryInput {
  readonly name?: string | undefined
  readonly source?: string | undefined
  readonly stageId?: string | undefined
  readonly companyId?: string | null | undefined
  readonly ownerId?: string | null | undefined
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

export interface EnquiriesService {
  list(
    actor: Actor,
    filters: EnquiryFilters,
    query: ListQueryParameters,
  ): Promise<Page<EnquiryView>>
  get(actor: Actor, id: string): Promise<EnquiryView>
  create(actor: Actor, input: CreateEnquiryInput): Promise<EnquiryView>
  update(actor: Actor, id: string, changes: UpdateEnquiryInput): Promise<EnquiryView>
  remove(actor: Actor, id: string): Promise<void>
}

function toView(record: EnquiryRecord, personIds: readonly string[]): EnquiryView {
  const { workspaceId: _workspaceId, ...view } = record

  return { ...view, personIds }
}

function toStoredColumns(input: UpdateEnquiryInput): Partial<repository.EnquiryColumns> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
    ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  }
}

export function createEnquiriesService(dependencies: EnquiriesDependencies): EnquiriesService {
  async function require(workspaceId: string, id: string): Promise<EnquiryRecord> {
    const enquiry = await repository.findEnquiry(dependencies.db, workspaceId, id)

    if (enquiry === undefined) {
      throw AppError.notFound('Enquiry not found')
    }

    return enquiry
  }

  async function requireCompany(workspaceId: string, companyId: string): Promise<void> {
    const company = await companyRepository.findCompany(dependencies.db, workspaceId, companyId)

    if (company === undefined) {
      throw AppError.notFound('Company not found')
    }
  }

  /**
   * A stage an enquiry may sit in: exists in this workspace and belongs to the
   * enquiry pipeline. The wrong-workspace case reads as missing; the
   * wrong-pipeline case is a request naming a real stage that can never hold an
   * enquiry, which is a validation error rather than a missing record.
   */
  async function requireEnquiryStage(
    workspaceId: string,
    stageId: string,
  ): Promise<PipelineStageRecord> {
    const stage = await pipelineRepository.findStage(dependencies.db, workspaceId, stageId)

    if (stage === undefined) {
      throw AppError.notFound('Pipeline stage not found')
    }

    if (stage.kind !== 'enquiry') {
      throw AppError.validationFailed('That stage is not part of the enquiry pipeline', [
        { field: 'stage_id', message: `It belongs to the ${stage.kind} pipeline` },
      ])
    }

    return stage
  }

  /** The default stage for a new enquiry: the first open one, or the first if none are open. */
  async function defaultEnquiryStage(workspaceId: string): Promise<PipelineStageRecord> {
    const rows = await pipelineRepository.listStagesOfKind(
      dependencies.db,
      workspaceId,
      'enquiry',
    )
    const first = rows.find((row) => row.open) ?? rows[0]

    if (first === undefined) {
      // Unreachable through the API: workspaces seed stages and the last stage
      // of a pipeline cannot be removed.
      throw AppError.conflict('This workspace has no enquiry stages')
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

  async function toViews(
    workspaceId: string,
    records: readonly EnquiryRecord[],
  ): Promise<EnquiryView[]> {
    const peopleByEnquiry = await personLinks.listPersonIdsFor(
      dependencies.db,
      workspaceId,
      'enquiry',
      records.map((record) => record.id),
    )

    return records.map((record) => toView(record, peopleByEnquiry.get(record.id) ?? []))
  }

  return {
    async list(actor, filters, query) {
      const workspaceId = requireWorkspaceId(actor)
      const window = readListWindow(query, ENQUIRY_SORTS, DEFAULT_ENQUIRY_SORT)
      const rows = await repository.listEnquiries(dependencies.db, workspaceId, filters, window)
      const page = toPage(rows, window, (enquiry) => enquiry.id)

      return { items: await toViews(workspaceId, page.items), nextCursor: page.nextCursor }
    },

    async get(actor, id) {
      const workspaceId = requireWorkspaceId(actor)
      const enquiry = await require(workspaceId, id)

      return toView(
        enquiry,
        await personLinks.listPersonIds(dependencies.db, workspaceId, {
          targetType: 'enquiry',
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
          ? await defaultEnquiryStage(workspaceId)
          : await requireEnquiryStage(workspaceId, input.stageId)
      const ownerId = input.ownerId === undefined ? actorMemberId(actor) : input.ownerId

      if (ownerId !== null) {
        await requireOwner(workspaceId, ownerId)
      }

      const personIds = [...new Set(input.personIds)]
      const named = await requirePeople(workspaceId, personIds)
      const id = dependencies.createId('enquiry')

      return dependencies.transaction(async ({ tx, events }) => {
        const customFields = await dependencies.customFields.forCreate(
          tx,
          workspaceId,
          'enquiry',
          input.customFields,
        )
        const created = await repository.insertEnquiry(tx, {
          id,
          workspaceId,
          name: input.name,
          source: input.source,
          stageId: stage.id,
          companyId: input.companyId,
          ownerId,
          convertedDealId: null,
          summary: input.summary,
          tags: [...input.tags],
          customFields,
        })

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'enquiry', targetId: id },
          personIds,
        )

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: 'enquiry',
          targetId: id,
          kind: 'created',
          ...describeCreation('Enquiry'),
        })

        for (const personId of personIds) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'enquiry',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        events.emit('enquiries.enquiry.created', { type: 'enquiry', id }, {})

        return toView(created, personIds)
      }, { workspaceId, actor: toEventActor(actor) })
    },

    async update(actor, id, changes) {
      const workspaceId = requireWorkspaceId(actor)
      const existing = await require(workspaceId, id)

      if (typeof changes.companyId === 'string' && changes.companyId !== existing.companyId) {
        await requireCompany(workspaceId, changes.companyId)
      }

      const stageMove =
        changes.stageId === undefined || changes.stageId === existing.stageId
          ? undefined
          : {
              from: await requireEnquiryStage(workspaceId, existing.stageId),
              to: await requireEnquiryStage(workspaceId, changes.stageId),
            }

      if (typeof changes.ownerId === 'string' && changes.ownerId !== existing.ownerId) {
        await requireOwner(workspaceId, changes.ownerId)
      }

      const currentPeople = await personLinks.listPersonIds(dependencies.db, workspaceId, {
        targetType: 'enquiry',
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
          'enquiry',
          existing.customFields,
          changes.customFields,
        )
        const customFieldsChanged = cf !== undefined && cf.changedPaths.length > 0

        if (scalarChanged.length === 0 && !linksChanged && !customFieldsChanged) {
          return toView(existing, currentPeople)
        }

        const updated = await repository.updateEnquiry(tx, workspaceId, id, {
          ...columns,
          ...(customFieldsChanged ? { customFields: cf.merged } : {}),
          updatedAt: dependencies.now(),
        })

        if (updated === undefined) {
          throw AppError.notFound('Enquiry not found')
        }

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: 'enquiry', targetId: id },
          added,
        )
        await personLinks.unlinkPeople(
          tx,
          workspaceId,
          { targetType: 'enquiry', targetId: id },
          removed,
        )

        if (stageMove !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'enquiry',
            targetId: id,
            kind: 'stage_changed',
            ...describeStageChange(stageMove.from.label, stageMove.to.label),
          })
        }

        const otherChanged = scalarChanged.filter((field) => field !== 'stageId')
        const customFieldPaths = cf?.changedPaths ?? []
        const activityChanged = [...otherChanged, ...customFieldPaths]

        if (activityChanged.length > 0) {
          const labels: Record<string, string> = { ...ENQUIRY_FIELD_LABELS, ...cf?.labels }
          const before: Record<string, unknown> = { ...existing, ...cf?.flatBefore }
          const after: Record<string, unknown> = { ...columns, ...cf?.flatAfter }
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'enquiry',
            targetId: id,
            kind: 'updated',
            ...describeUpdate(activityChanged, labels, before, after),
          })
        }

        for (const personId of added) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'enquiry',
            targetId: id,
            kind: 'linked',
            ...describeLink('person', named.get(personId) ?? personId),
          })
        }

        for (const personId of removed) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: 'enquiry',
            targetId: id,
            kind: 'unlinked',
            ...describeUnlink('person', named.get(personId) ?? personId),
          })
        }

        events.emit(
          'enquiries.enquiry.updated',
          { type: 'enquiry', id },
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
            'enquiries.enquiry.stage_changed',
            { type: 'enquiry', id },
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

        await clearConversionPointersToTarget(tx, workspaceId, 'enquiry', id)

        // Notes, activities, decisions, plan items, person_links, list
        // memberships and form_attach_targets rows are removed here in the
        // same transaction. `form_submissions.enquiry_id` is a set-null FK, so
        // the DB clears it on its own.
        await deleteRecordsAttachedTo(tx, workspaceId, 'enquiry', id)
        await repository.deleteEnquiry(tx, workspaceId, id)

        events.emit('enquiries.enquiry.deleted', { type: 'enquiry', id }, {})
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

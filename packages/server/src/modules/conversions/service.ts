import type { ConvertPipelineRecordInput, PipelineKind } from '@kelpie/schemas'

import { toEventActor } from '../../lib/actor.ts'
import type { Actor } from '../auth/actor.ts'
import { requireWorkspaceId } from '../auth/actor.ts'
import { AppError } from '../../lib/errors.ts'
import type { Database } from '../../lib/database.ts'
import type { IdFactory } from '../../lib/ids.ts'
import type { TransactionScope } from '../../runtime/transaction.ts'
import type { EventName } from '../../runtime/events.ts'
import type { ActivityRecorder } from '../activities/recorder.ts'
import {
  describeConversion,
  describeCreationFrom,
  describeStageChange,
} from '../activities/wording.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import * as personLinks from '../personLinks.ts'
import * as pipelineRepository from '../pipelines/repository.ts'
import {
  assertNotAlreadyConverted,
  buildTargetInsertPayload,
  insertConvertedTarget,
  intersectCustomFields,
  loadPipelineSnapshot,
  markSourceConverted,
  objectLabelFor,
  type ConvertedTargetRecord,
} from './fieldMap.ts'
import { repointRecordsAttachedTo } from './repoint.ts'

export interface ConversionsDependencies {
  readonly db: Database
  readonly transaction: TransactionScope
  readonly createId: IdFactory
  readonly now: () => Date
  readonly recordActivity: ActivityRecorder
  readonly customFields: CustomFieldValuesValidator
}

export interface ConvertPipelineRecordResult {
  readonly targetKind: PipelineKind
  readonly target: ConvertedTargetRecord
  readonly personIds: readonly string[]
}

export interface ConversionsService {
  convert(
    actor: Actor,
    sourceKind: PipelineKind,
    sourceId: string,
    body: ConvertPipelineRecordInput,
  ): Promise<ConvertPipelineRecordResult>
}

function conversionEventName(sourceKind: PipelineKind): EventName {
  switch (sourceKind) {
    case 'enquiry':
      return 'enquiries.enquiry.converted'
    case 'deal':
      return 'deals.deal.converted'
    case 'opportunity':
      return 'opportunities.opportunity.converted'
    case 'raise':
      return 'raises.raise.converted'
    case 'partnership':
      return 'partnerships.partnership.converted'
  }
}

function createdEventName(targetKind: PipelineKind): EventName {
  switch (targetKind) {
    case 'enquiry':
      return 'enquiries.enquiry.created'
    case 'deal':
      return 'deals.deal.created'
    case 'opportunity':
      return 'opportunities.opportunity.created'
    case 'raise':
      return 'raises.raise.created'
    case 'partnership':
      return 'partnerships.partnership.created'
  }
}

function updatedEventName(sourceKind: PipelineKind): EventName {
  switch (sourceKind) {
    case 'enquiry':
      return 'enquiries.enquiry.updated'
    case 'deal':
      return 'deals.deal.updated'
    case 'opportunity':
      return 'opportunities.opportunity.updated'
    case 'raise':
      return 'raises.raise.updated'
    case 'partnership':
      return 'partnerships.partnership.updated'
  }
}

function stageChangedEventName(sourceKind: PipelineKind): EventName {
  switch (sourceKind) {
    case 'enquiry':
      return 'enquiries.enquiry.stage_changed'
    case 'deal':
      return 'deals.deal.stage_changed'
    case 'opportunity':
      return 'opportunities.opportunity.stage_changed'
    case 'raise':
      return 'raises.raise.stage_changed'
    case 'partnership':
      return 'partnerships.partnership.stage_changed'
  }
}

function targetEventType(kind: PipelineKind): string {
  switch (kind) {
    case 'enquiry':
      return 'enquiry'
    case 'deal':
      return 'deal'
    case 'opportunity':
      return 'opportunity'
    case 'raise':
      return 'raise'
    case 'partnership':
      return 'partnership'
  }
}

export function createConversionsService(dependencies: ConversionsDependencies): ConversionsService {
  return {
    async convert(actor, sourceKind, sourceId, body) {
      const workspaceId = requireWorkspaceId(actor)
      const targetKind = body.targetType

      if (sourceKind === targetKind) {
        throw AppError.validationFailed('Choose a different target type to convert into', [
          { field: 'target_type', message: `Already a ${objectLabelFor(sourceKind)}` },
        ])
      }

      const source = await loadPipelineSnapshot(dependencies.db, workspaceId, sourceKind, sourceId)

      if (source === undefined) {
        throw AppError.notFound(`${objectLabelFor(sourceKind)} not found`)
      }

      assertNotAlreadyConverted(source)

      const targetStages = await pipelineRepository.listStagesOfKind(
        dependencies.db,
        workspaceId,
        targetKind,
      )
      const openTargetStage = targetStages.find((row) => row.open) ?? targetStages[0]

      if (openTargetStage === undefined) {
        throw AppError.conflict(`This workspace has no ${objectLabelFor(targetKind).toLowerCase()} stages`)
      }

      if (body.stageId !== undefined) {
        const chosen = targetStages.find((row) => row.id === body.stageId)

        if (chosen === undefined) {
          throw AppError.validationFailed('Stage not found for this target type', [
            { field: 'stage_id', message: body.stageId },
          ])
        }
      }

      const sourceStages = await pipelineRepository.listStagesOfKind(
        dependencies.db,
        workspaceId,
        sourceKind,
      )
      const closedSourceStage = sourceStages.find((row) => !row.open)
      const currentSourceStage = sourceStages.find((row) => row.id === source.stageId)

      const personIds = await personLinks.listPersonIds(dependencies.db, workspaceId, {
        targetType: sourceKind,
        targetId: sourceId,
      })
      const targetId = dependencies.createId(targetKind)
      const now = dependencies.now()
      const sourceLabel = objectLabelFor(sourceKind)
      const targetLabel = objectLabelFor(targetKind)

      return dependencies.transaction(async ({ tx, events }) => {
        const payload = buildTargetInsertPayload(
          source,
          targetKind,
          body,
          openTargetStage.id,
        )
        const customFields = await intersectCustomFields(
          tx,
          workspaceId,
          targetKind,
          source.customFields,
          dependencies.customFields,
        )
        const target = await insertConvertedTarget(
          tx,
          workspaceId,
          targetKind,
          targetId,
          payload,
          customFields,
          now,
        )

        await personLinks.linkPeople(
          tx,
          dependencies.createId,
          workspaceId,
          { targetType: targetKind, targetId },
          personIds,
        )

        await repointRecordsAttachedTo(
          tx,
          workspaceId,
          { targetType: sourceKind, targetId: sourceId },
          { targetType: targetKind, targetId },
        )

        const stageChanged =
          closedSourceStage !== undefined && closedSourceStage.id !== source.stageId

        await markSourceConverted(
          tx,
          workspaceId,
          source,
          targetKind,
          targetId,
          stageChanged ? closedSourceStage.id : undefined,
          now,
        )

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: targetKind,
          targetId,
          kind: 'created',
          ...describeCreationFrom(targetLabel, sourceLabel, source.name),
        })

        await dependencies.recordActivity(tx, workspaceId, actor, {
          targetType: sourceKind,
          targetId: sourceId,
          kind: 'updated',
          ...describeConversion(targetLabel, payload.name),
        })

        if (stageChanged && currentSourceStage !== undefined) {
          await dependencies.recordActivity(tx, workspaceId, actor, {
            targetType: sourceKind,
            targetId: sourceId,
            kind: 'stage_changed',
            ...describeStageChange(currentSourceStage.label, closedSourceStage.label),
          })
        }

        events.emit(createdEventName(targetKind), { type: targetEventType(targetKind), id: targetId }, {})

        const sourceChanged: string[] = stageChanged
          ? ['convertedTargetType', 'convertedTargetId', 'stageId']
          : ['convertedTargetType', 'convertedTargetId']

        if (source.kind === 'enquiry' && targetKind === 'deal') {
          sourceChanged.push('convertedDealId')
        }

        events.emit(
          updatedEventName(sourceKind),
          { type: targetEventType(sourceKind), id: sourceId },
          { changed: sourceChanged },
        )

        if (stageChanged && currentSourceStage !== undefined) {
          events.emit(
            stageChangedEventName(sourceKind),
            { type: targetEventType(sourceKind), id: sourceId },
            { fromStageId: currentSourceStage.id, toStageId: closedSourceStage.id },
          )
        }

        const conversionPayload =
          sourceKind === 'enquiry' && targetKind === 'deal'
            ? { dealId: targetId, targetType: targetKind, targetId }
            : { targetType: targetKind, targetId }

        events.emit(
          conversionEventName(sourceKind),
          { type: targetEventType(sourceKind), id: sourceId },
          conversionPayload,
        )

        return { targetKind, target, personIds }
      }, { workspaceId, actor: toEventActor(actor) })
    },
  }
}

/** Factory helper shared by pipeline modules. */
export function createSharedConversionsService(
  dependencies: ConversionsDependencies,
): ConversionsService {
  return createConversionsService(dependencies)
}

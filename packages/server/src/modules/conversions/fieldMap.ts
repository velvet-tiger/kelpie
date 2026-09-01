import type { CustomFieldValue, CustomFieldWireValue, PipelineKind } from '@kelpie/schemas'
import { PIPELINE_KIND_LABELS } from '@kelpie/schemas'
import type { ConvertPipelineRecordInput } from '@kelpie/schemas'

import { AppError } from '../../lib/errors.ts'
import type { CustomFieldValuesValidator } from '../custom-fields/values.ts'
import * as dealRepository from '../deals/repository.ts'
import type { DealRecord } from '../deals/repository.ts'
import * as enquiryRepository from '../enquiries/repository.ts'
import type { EnquiryRecord } from '../enquiries/repository.ts'
import * as opportunityRepository from '../opportunities/repository.ts'
import type { OpportunityRecord } from '../opportunities/repository.ts'
import * as partnershipRepository from '../partnerships/repository.ts'
import type { PartnershipRecord } from '../partnerships/repository.ts'
import * as raiseRepository from '../raises/repository.ts'
import type { RaiseRecord } from '../raises/repository.ts'
import { definitionsForObject } from '../custom-fields/repository.ts'

/** Shared scalar fields every pipeline record carries. */
export interface PipelineSnapshot {
  readonly kind: PipelineKind
  readonly id: string
  readonly name: string
  readonly companyId: string | null
  readonly ownerId: string | null
  readonly summary: string
  readonly tags: readonly string[]
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
  readonly stageId: string
  readonly convertedTargetType: string | null
  readonly convertedTargetId: string | null
  readonly convertedDealId: string | null
  readonly source: string | null
  readonly kindField: string | null
  readonly expectedClose: string | null
  readonly nextTouchpoint: string | null
  readonly valueCents: number | null
  readonly currency: string | null
  readonly checkSizeCents: number | null
}

const COMPANY_REQUIRED_TARGETS = new Set<PipelineKind>(['deal', 'raise', 'partnership'])

export function objectLabelFor(kind: PipelineKind): string {
  return PIPELINE_KIND_LABELS[kind]
}

export async function loadPipelineSnapshot(
  db: Parameters<CustomFieldValuesValidator['forCreate']>[0],
  workspaceId: string,
  kind: PipelineKind,
  id: string,
): Promise<PipelineSnapshot | undefined> {
  switch (kind) {
    case 'enquiry': {
      const row = await enquiryRepository.findEnquiry(db, workspaceId, id)

      if (row === undefined) {
        return undefined
      }

      return snapshotFromEnquiry(row)
    }
    case 'deal': {
      const row = await dealRepository.findDeal(db, workspaceId, id)

      if (row === undefined) {
        return undefined
      }

      return snapshotFromDeal(row)
    }
    case 'opportunity': {
      const row = await opportunityRepository.findOpportunity(db, workspaceId, id)

      if (row === undefined) {
        return undefined
      }

      return snapshotFromOpportunity(row)
    }
    case 'raise': {
      const row = await raiseRepository.findRaise(db, workspaceId, id)

      if (row === undefined) {
        return undefined
      }

      return snapshotFromRaise(row)
    }
    case 'partnership': {
      const row = await partnershipRepository.findPartnership(db, workspaceId, id)

      if (row === undefined) {
        return undefined
      }

      return snapshotFromPartnership(row)
    }
  }
}

function snapshotFromEnquiry(row: EnquiryRecord): PipelineSnapshot {
  return {
    kind: 'enquiry',
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    ownerId: row.ownerId,
    summary: row.summary,
    tags: row.tags,
    customFields: row.customFields,
    stageId: row.stageId,
    convertedTargetType: row.convertedTargetType,
    convertedTargetId: row.convertedTargetId,
    convertedDealId: row.convertedDealId,
    source: row.source,
    kindField: null,
    expectedClose: null,
    nextTouchpoint: null,
    valueCents: null,
    currency: null,
    checkSizeCents: null,
  }
}

function snapshotFromDeal(row: DealRecord): PipelineSnapshot {
  return {
    kind: 'deal',
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    ownerId: row.ownerId,
    summary: row.summary,
    tags: row.tags,
    customFields: row.customFields,
    stageId: row.stageId,
    convertedTargetType: row.convertedTargetType,
    convertedTargetId: row.convertedTargetId,
    convertedDealId: null,
    source: null,
    kindField: null,
    expectedClose: row.expectedClose,
    nextTouchpoint: null,
    valueCents: row.valueCents,
    currency: row.currency,
    checkSizeCents: null,
  }
}

function snapshotFromOpportunity(row: OpportunityRecord): PipelineSnapshot {
  return {
    kind: 'opportunity',
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    ownerId: row.ownerId,
    summary: row.summary,
    tags: row.tags,
    customFields: row.customFields,
    stageId: row.stageId,
    convertedTargetType: row.convertedTargetType,
    convertedTargetId: row.convertedTargetId,
    convertedDealId: null,
    source: null,
    kindField: row.kind,
    expectedClose: row.expectedClose,
    nextTouchpoint: null,
    valueCents: null,
    currency: null,
    checkSizeCents: null,
  }
}

function snapshotFromRaise(row: RaiseRecord): PipelineSnapshot {
  return {
    kind: 'raise',
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    ownerId: row.ownerId,
    summary: row.summary,
    tags: row.tags,
    customFields: row.customFields,
    stageId: row.stageId,
    convertedTargetType: row.convertedTargetType,
    convertedTargetId: row.convertedTargetId,
    convertedDealId: null,
    source: null,
    kindField: null,
    expectedClose: row.expectedClose,
    nextTouchpoint: null,
    valueCents: null,
    currency: row.currency,
    checkSizeCents: row.checkSizeCents,
  }
}

function snapshotFromPartnership(row: PartnershipRecord): PipelineSnapshot {
  return {
    kind: 'partnership',
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    ownerId: row.ownerId,
    summary: row.summary,
    tags: row.tags,
    customFields: row.customFields,
    stageId: row.stageId,
    convertedTargetType: row.convertedTargetType,
    convertedTargetId: row.convertedTargetId,
    convertedDealId: null,
    source: null,
    kindField: row.kind,
    expectedClose: null,
    nextTouchpoint: row.nextTouchpoint,
    valueCents: null,
    currency: null,
    checkSizeCents: null,
  }
}

export function assertNotAlreadyConverted(source: PipelineSnapshot): void {
  if (source.convertedTargetId !== null || source.convertedDealId !== null) {
    const existingId = source.convertedTargetId ?? source.convertedDealId

    throw new AppError(
      'conflict',
      'This record has already been converted',
      [{ field: 'converted_to', message: existingId ?? 'unknown' }],
    )
  }
}

export function resolveCompanyId(
  source: PipelineSnapshot,
  targetKind: PipelineKind,
  override: string | undefined,
): string | null {
  const companyId = override ?? source.companyId

  if (COMPANY_REQUIRED_TARGETS.has(targetKind) && companyId === null) {
    throw AppError.validationFailed(
      `A ${objectLabelFor(targetKind).toLowerCase()} needs a company before conversion`,
      [{ field: 'company_id', message: 'Link a company to the record first, or send company_id' }],
    )
  }

  return companyId
}

export async function intersectCustomFields(
  tx: Parameters<CustomFieldValuesValidator['forCreate']>[0],
  workspaceId: string,
  targetKind: PipelineKind,
  sourceCustomFields: Readonly<Record<string, CustomFieldValue>>,
  customFields: CustomFieldValuesValidator,
): Promise<Readonly<Record<string, CustomFieldValue>>> {
  const targetDefinitions = await definitionsForObject(tx, workspaceId, targetKind)
  const targetKeys = new Set(targetDefinitions.map((definition) => definition.key))
  const raw: Record<string, CustomFieldWireValue> = {}

  for (const [key, value] of Object.entries(sourceCustomFields)) {
    if (targetKeys.has(key)) {
      raw[key] = value as CustomFieldWireValue
    }
  }

  return customFields.forCreate(tx, workspaceId, targetKind, raw)
}

export interface TargetInsertPayload {
  readonly name: string
  readonly companyId: string | null
  readonly ownerId: string | null
  readonly summary: string
  readonly tags: readonly string[]
  readonly customFields: Readonly<Record<string, CustomFieldValue>>
  readonly stageId: string
  readonly kindField: string
  readonly expectedClose: string | null
  readonly nextTouchpoint: string | null
  readonly valueCents: number | null
  readonly currency: string | null
  readonly checkSizeCents: number | null
}

export function buildTargetInsertPayload(
  source: PipelineSnapshot,
  targetKind: PipelineKind,
  body: ConvertPipelineRecordInput,
  targetStageId: string,
): TargetInsertPayload {
  const companyId = resolveCompanyId(source, targetKind, body.companyId)
  const name = body.name ?? source.name
  const kindField =
    body.kind ??
    (source.kindField !== null && (targetKind === 'opportunity' || targetKind === 'partnership')
      ? source.kindField
      : '')

  let expectedClose = source.expectedClose
  let nextTouchpoint = source.nextTouchpoint
  let valueCents = source.valueCents
  let currency = source.currency
  let checkSizeCents = source.checkSizeCents

  if (targetKind === 'partnership') {
    expectedClose = null
    nextTouchpoint = source.expectedClose ?? source.nextTouchpoint
    valueCents = null
    checkSizeCents = null
  } else if (targetKind === 'deal') {
    nextTouchpoint = null
    if (source.kind === 'raise') {
      valueCents = source.checkSizeCents
      checkSizeCents = null
    }
  } else if (targetKind === 'raise') {
    nextTouchpoint = null
    if (source.kind === 'deal') {
      checkSizeCents = source.valueCents
      valueCents = null
    }
  } else if (targetKind === 'opportunity' || targetKind === 'enquiry') {
    nextTouchpoint = null
    valueCents = null
    checkSizeCents = null
  }

  if (targetKind !== 'deal' && targetKind !== 'opportunity' && targetKind !== 'raise') {
    expectedClose = null
  }

  if (targetKind !== 'partnership') {
    nextTouchpoint = null
  }

  return {
    name,
    companyId,
    ownerId: source.ownerId,
    summary: source.summary,
    tags: source.tags,
    customFields: {},
    stageId: body.stageId ?? targetStageId,
    kindField,
    expectedClose,
    nextTouchpoint,
    valueCents,
    currency: currency ?? (targetKind === 'deal' || targetKind === 'raise' ? 'USD' : null),
    checkSizeCents,
  }
}

export type ConvertedTargetRecord =
  | DealRecord
  | EnquiryRecord
  | OpportunityRecord
  | RaiseRecord
  | PartnershipRecord

export async function insertConvertedTarget(
  tx: Parameters<CustomFieldValuesValidator['forCreate']>[0],
  workspaceId: string,
  targetKind: PipelineKind,
  targetId: string,
  payload: TargetInsertPayload,
  customFields: Readonly<Record<string, CustomFieldValue>>,
  now: Date,
): Promise<ConvertedTargetRecord> {
  switch (targetKind) {
    case 'enquiry':
      return enquiryRepository.insertEnquiry(tx, {
        id: targetId,
        workspaceId,
        name: payload.name,
        source: '',
        stageId: payload.stageId,
        companyId: payload.companyId,
        ownerId: payload.ownerId,
        convertedDealId: null,
        convertedTargetType: null,
        convertedTargetId: null,
        summary: payload.summary,
        tags: [...payload.tags],
        customFields,
        createdAt: now,
        updatedAt: now,
      })
    case 'deal':
      return dealRepository.insertDeal(tx, {
        id: targetId,
        workspaceId,
        name: payload.name,
        companyId: payload.companyId as string,
        stageId: payload.stageId,
        valueCents: payload.valueCents,
        currency: payload.currency,
        ownerId: payload.ownerId,
        expectedClose: payload.expectedClose,
        competitors: [],
        risks: '',
        whyWin: '',
        summary: payload.summary,
        tags: [...payload.tags],
        externalId: null,
        convertedTargetType: null,
        convertedTargetId: null,
        customFields,
      })
    case 'opportunity':
      return opportunityRepository.insertOpportunity(tx, {
        id: targetId,
        workspaceId,
        name: payload.name,
        kind: payload.kindField,
        stageId: payload.stageId,
        companyId: payload.companyId,
        ownerId: payload.ownerId,
        expectedClose: payload.expectedClose,
        summary: payload.summary,
        tags: [...payload.tags],
        convertedTargetType: null,
        convertedTargetId: null,
        customFields,
        createdAt: now,
        updatedAt: now,
      })
    case 'raise':
      return raiseRepository.insertRaise(tx, {
        id: targetId,
        workspaceId,
        name: payload.name,
        companyId: payload.companyId as string,
        stageId: payload.stageId,
        checkSizeCents: payload.checkSizeCents,
        currency: payload.currency,
        thesisFit: '',
        passReason: null,
        ownerId: payload.ownerId,
        expectedClose: payload.expectedClose,
        summary: payload.summary,
        tags: [...payload.tags],
        convertedTargetType: null,
        convertedTargetId: null,
        customFields,
        createdAt: now,
        updatedAt: now,
      })
    case 'partnership':
      return partnershipRepository.insertPartnership(tx, {
        id: targetId,
        workspaceId,
        name: payload.name,
        companyId: payload.companyId as string,
        stageId: payload.stageId,
        kind: payload.kindField,
        nextTouchpoint: payload.nextTouchpoint,
        ownerId: payload.ownerId,
        goals: '',
        successLooksLike: '',
        summary: payload.summary,
        tags: [...payload.tags],
        convertedTargetType: null,
        convertedTargetId: null,
        customFields,
        createdAt: now,
        updatedAt: now,
      })
  }
}

export async function markSourceConverted(
  tx: Parameters<CustomFieldValuesValidator['forCreate']>[0],
  workspaceId: string,
  source: PipelineSnapshot,
  targetKind: PipelineKind,
  targetId: string,
  closedStageId: string | undefined,
  now: Date,
): Promise<void> {
  const convertedChanges = {
    convertedTargetType: targetKind,
    convertedTargetId: targetId,
    updatedAt: now,
    ...(source.kind === 'enquiry' && targetKind === 'deal' ? { convertedDealId: targetId } : {}),
    ...(closedStageId === undefined ? {} : { stageId: closedStageId }),
  }

  switch (source.kind) {
    case 'enquiry': {
      const updated = await enquiryRepository.updateEnquiry(tx, workspaceId, source.id, convertedChanges)

      if (updated === undefined) {
        throw AppError.notFound('Enquiry not found')
      }

      return
    }
    case 'deal': {
      const updated = await dealRepository.updateDeal(tx, workspaceId, source.id, convertedChanges)

      if (updated === undefined) {
        throw AppError.notFound('Deal not found')
      }

      return
    }
    case 'opportunity': {
      const updated = await opportunityRepository.updateOpportunity(
        tx,
        workspaceId,
        source.id,
        convertedChanges,
      )

      if (updated === undefined) {
        throw AppError.notFound('Opportunity not found')
      }

      return
    }
    case 'raise': {
      const updated = await raiseRepository.updateRaise(tx, workspaceId, source.id, convertedChanges)

      if (updated === undefined) {
        throw AppError.notFound('Raise not found')
      }

      return
    }
    case 'partnership': {
      const updated = await partnershipRepository.updatePartnership(
        tx,
        workspaceId,
        source.id,
        convertedChanges,
      )

      if (updated === undefined) {
        throw AppError.notFound('Partnership not found')
      }

      return
    }
  }
}

import type { CustomFieldObjectType, CustomFieldType, CustomFieldValue, CustomFieldWireValue } from '@kelpie/schemas'

import type { Transaction } from '../../runtime/transaction.ts'
import { createCustomFieldValues } from '../custom-fields/values.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import * as companyRepository from '../companies/repository.ts'
import type { CompanyRecord } from '../companies/repository.ts'
import * as dealRepository from '../deals/repository.ts'
import type { DealRecord } from '../deals/repository.ts'
import * as enquiryRepository from '../enquiries/repository.ts'
import type { EnquiryRecord } from '../enquiries/repository.ts'
import * as opportunityRepository from '../opportunities/repository.ts'
import type { OpportunityRecord } from '../opportunities/repository.ts'
import * as partnershipRepository from '../partnerships/repository.ts'
import type { PartnershipRecord } from '../partnerships/repository.ts'
import * as peopleRepository from '../people/repository.ts'
import type { PersonRecord } from '../people/repository.ts'
import * as raiseRepository from '../raises/repository.ts'
import type { RaiseRecord } from '../raises/repository.ts'
import {
  applyStandardFillBlank,
  customFieldsFillBlankPatch,
  hasObjectMappedValues,
  parseCustomFieldAnswer,
  valuesForObject,
} from './applyMappedFields.ts'
import type { MappedAnswers } from './mapping.ts'

const customFieldValues = createCustomFieldValues({ db: null as never })

const PERSON_FIELD_COLUMNS: Readonly<Record<string, keyof PersonRecord>> = {
  salutation: 'salutation',
  suffix: 'suffix',
  timezone: 'timezone',
  location: 'location',
  preferred_channel: 'preferredChannel',
  influence: 'influence',
  relationship: 'relationship',
  summary: 'summary',
  tags: 'tags',
  do_not_contact: 'doNotContact',
}

const COMPANY_FIELD_COLUMNS: Readonly<Record<string, keyof CompanyRecord>> = {
  industry: 'industry',
  description: 'description',
  stage: 'stage',
  size_band: 'sizeBand',
  hq: 'hq',
  website: 'website',
  account_type: 'accountType',
  icp_fit: 'icpFit',
  tech_stack: 'techStack',
  summary: 'summary',
  tags: 'tags',
}

const DEAL_FIELD_COLUMNS: Readonly<Record<string, keyof DealRecord>> = {
  value_cents: 'valueCents',
  currency: 'currency',
  expected_close: 'expectedClose',
  competitors: 'competitors',
  risks: 'risks',
  why_win: 'whyWin',
  summary: 'summary',
  tags: 'tags',
  external_id: 'externalId',
}

const OPPORTUNITY_FIELD_COLUMNS: Readonly<Record<string, keyof OpportunityRecord>> = {
  kind: 'kind',
  expected_close: 'expectedClose',
  summary: 'summary',
  tags: 'tags',
}

const PARTNERSHIP_FIELD_COLUMNS: Readonly<Record<string, keyof PartnershipRecord>> = {
  kind: 'kind',
  next_touchpoint: 'nextTouchpoint',
  goals: 'goals',
  success_looks_like: 'successLooksLike',
  summary: 'summary',
  tags: 'tags',
}

const ENQUIRY_FIELD_COLUMNS: Readonly<Record<string, keyof EnquiryRecord>> = {
  source: 'source',
  summary: 'summary',
  tags: 'tags',
}

const RAISE_FIELD_COLUMNS: Readonly<Record<string, keyof RaiseRecord>> = {
  check_size_cents: 'checkSizeCents',
  currency: 'currency',
  thesis_fit: 'thesisFit',
  pass_reason: 'passReason',
  expected_close: 'expectedClose',
  summary: 'summary',
  tags: 'tags',
}

async function buildCustomFieldsPatch(
  tx: Transaction,
  workspaceId: string,
  objectType: CustomFieldObjectType,
  stored: Readonly<Record<string, CustomFieldValue>>,
  inbound: Readonly<Record<string, string>>,
  definitions: readonly CustomFieldDefinitionRecord[],
): Promise<Readonly<Record<string, CustomFieldValue>> | undefined> {
  const blanks = customFieldsFillBlankPatch(stored, inbound)

  if (Object.keys(blanks).length === 0) {
    return undefined
  }

  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  const sent: Record<string, CustomFieldWireValue | null> = {}

  for (const [key, raw] of Object.entries(blanks)) {
    const definition = byKey.get(key)

    if (definition === undefined) {
      continue
    }

    sent[key] = parseCustomFieldAnswer(
      {
        objectType: definition.objectType as CustomFieldObjectType,
        key: definition.key,
        label: definition.label,
        type: definition.type as CustomFieldType,
      },
      raw,
    ) as CustomFieldWireValue
  }

  if (Object.keys(sent).length === 0) {
    return undefined
  }

  try {
    const merged = await customFieldValues.forUpdate(tx, workspaceId, objectType, stored, sent)
    return merged?.merged
  } catch {
    // A form answer that does not validate as the custom field's type is skipped
    // rather than failing the whole submit — the visitor typed something the
    // field type cannot store.
    return undefined
  }
}

function columnLookup(
  map: Readonly<Record<string, string>>,
): (field: string) => string | undefined {
  return (field: string) => map[field]
}

export async function applyPersonMappedFields(
  tx: Transaction,
  workspaceId: string,
  person: PersonRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<PersonRecord> {
  const values = valuesForObject(mapped, 'person')

  if (!hasObjectMappedValues(values)) {
    return person
  }

  const standardPatch = applyStandardFillBlank(person, 'person', values, columnLookup(PERSON_FIELD_COLUMNS))
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'person',
    person.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return person
  }

  const updated = await peopleRepository.updatePerson(tx, workspaceId, person.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? person
}

export async function applyCompanyMappedFields(
  tx: Transaction,
  workspaceId: string,
  company: CompanyRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<CompanyRecord> {
  const values = valuesForObject(mapped, 'company')

  if (!hasObjectMappedValues(values)) {
    return company
  }

  const standardPatch = applyStandardFillBlank(
    company,
    'company',
    values,
    columnLookup(COMPANY_FIELD_COLUMNS),
  )
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'company',
    company.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return company
  }

  const updated = await companyRepository.updateCompany(tx, workspaceId, company.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? company
}

export async function applyDealMappedFields(
  tx: Transaction,
  workspaceId: string,
  deal: DealRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<DealRecord> {
  const values = valuesForObject(mapped, 'deal')

  if (!hasObjectMappedValues(values)) {
    return deal
  }

  const standardPatch = applyStandardFillBlank(deal, 'deal', values, columnLookup(DEAL_FIELD_COLUMNS))
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'deal',
    deal.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return deal
  }

  const updated = await dealRepository.updateDeal(tx, workspaceId, deal.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? deal
}

export async function applyOpportunityMappedFields(
  tx: Transaction,
  workspaceId: string,
  opportunity: OpportunityRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<OpportunityRecord> {
  const values = valuesForObject(mapped, 'opportunity')

  if (!hasObjectMappedValues(values)) {
    return opportunity
  }

  const standardPatch = applyStandardFillBlank(
    opportunity,
    'opportunity',
    values,
    columnLookup(OPPORTUNITY_FIELD_COLUMNS),
  )
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'opportunity',
    opportunity.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return opportunity
  }

  const updated = await opportunityRepository.updateOpportunity(tx, workspaceId, opportunity.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? opportunity
}

export async function applyPartnershipMappedFields(
  tx: Transaction,
  workspaceId: string,
  partnership: PartnershipRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<PartnershipRecord> {
  const values = valuesForObject(mapped, 'partnership')

  if (!hasObjectMappedValues(values)) {
    return partnership
  }

  const standardPatch = applyStandardFillBlank(
    partnership,
    'partnership',
    values,
    columnLookup(PARTNERSHIP_FIELD_COLUMNS),
  )
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'partnership',
    partnership.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return partnership
  }

  const updated = await partnershipRepository.updatePartnership(tx, workspaceId, partnership.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? partnership
}

export async function applyEnquiryMappedFields(
  tx: Transaction,
  workspaceId: string,
  enquiry: EnquiryRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<EnquiryRecord> {
  const values = valuesForObject(mapped, 'enquiry')

  if (!hasObjectMappedValues(values)) {
    return enquiry
  }

  const standardPatch = applyStandardFillBlank(
    enquiry,
    'enquiry',
    values,
    columnLookup(ENQUIRY_FIELD_COLUMNS),
  )
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'enquiry',
    enquiry.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return enquiry
  }

  const updated = await enquiryRepository.updateEnquiry(tx, workspaceId, enquiry.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? enquiry
}

export async function applyRaiseMappedFields(
  tx: Transaction,
  workspaceId: string,
  raise: RaiseRecord,
  mapped: MappedAnswers,
  definitions: readonly CustomFieldDefinitionRecord[],
  now: Date,
): Promise<RaiseRecord> {
  const values = valuesForObject(mapped, 'raise')

  if (!hasObjectMappedValues(values)) {
    return raise
  }

  const standardPatch = applyStandardFillBlank(raise, 'raise', values, columnLookup(RAISE_FIELD_COLUMNS))
  const customFields = await buildCustomFieldsPatch(
    tx,
    workspaceId,
    'raise',
    raise.customFields,
    values.custom,
    definitions,
  )

  if (Object.keys(standardPatch).length === 0 && customFields === undefined) {
    return raise
  }

  const updated = await raiseRepository.updateRaise(tx, workspaceId, raise.id, {
    ...standardPatch,
    ...(customFields === undefined ? {} : { customFields }),
    updatedAt: now,
  })

  return updated ?? raise
}

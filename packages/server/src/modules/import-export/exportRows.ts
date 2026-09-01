import { OBJECT_COLUMNS, customFieldObjectTypeForExport } from '@kelpie/schemas'
import type { CsvColumn, CustomFieldValue, ExportObject } from '@kelpie/schemas'

import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { customFieldCells, customFieldDefinitionCells, customFieldHeaderKeys } from './customFieldCsv.ts'
import { centsToMoney } from './mapping.ts'
import type {
  ExportCompanyRow,
  ExportDealRow,
  ExportEnquiryRow,
  ExportOpportunityRow,
  ExportPartnershipRow,
  ExportPersonRow,
  ExportPositionRow,
  ExportRaiseRow,
} from './repository.ts'

/**
 * Records as CSV cells, in the header order of `OBJECT_COLUMNS` and
 * `EXPORT_ONLY_COLUMNS`, plus workspace custom field keys when the object
 * carries them.
 *
 * An export writes what an import reads where import exists: the stage is its
 * **slug**, and money is the major unit rather than cents. Custom field values
 * append as columns named by definition key.
 *
 * Pure.
 */

/** Pipe-separated, per `import-export.md`. */
function joinList(values: readonly string[]): string {
  return values.join('|')
}

function baseColumnsFor(object: ExportObject): readonly CsvColumn[] {
  return OBJECT_COLUMNS[object]
}

/**
 * The header row of an export and of a template.
 *
 * `importOnly` columns are left out. Custom field definition keys append in
 * workspace sort order when the object type carries custom fields.
 */
export function headersFor(
  object: ExportObject,
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  const base = baseColumnsFor(object)
    .filter((column) => column.importOnly !== true)
    .map((column) => column.key)

  if (customFieldObjectTypeForExport(object) === null) {
    return base
  }

  return [...base, ...customFieldHeaderKeys(definitions)]
}

/** The template's headers — the round-trippable ones for a caller to fill in. */
export function templateHeadersFor(
  object: ExportObject,
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  const base = baseColumnsFor(object)
    .filter((column) => column.importOnly !== true && column.exportOnly !== true)
    .map((column) => column.key)

  if (customFieldObjectTypeForExport(object) === null) {
    return base
  }

  return [...base, ...customFieldHeaderKeys(definitions)]
}

function withCustomFields(
  base: readonly string[],
  customFields: Readonly<Record<string, CustomFieldValue>> | undefined,
  definitions: readonly CustomFieldDefinitionRecord[],
): readonly string[] {
  if (definitions.length === 0) {
    return base
  }

  return [...base, ...customFieldCells(customFields, customFieldHeaderKeys(definitions))]
}

export function companyCells(
  row: ExportCompanyRow,
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.domain ?? '',
      row.industry ?? '',
      row.stage,
      row.sizeBand,
      row.accountType,
      row.icpFit,
      row.description,
      row.summary,
      joinList(row.tags),
      row.website ?? '',
      row.hq ?? '',
    ],
    row.customFields,
    definitions,
  )
}

export function personCells(
  row: ExportPersonRow,
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.salutation ?? '',
      row.firstName ?? '',
      row.lastName ?? '',
      row.suffix ?? '',
      row.email ?? '',
      row.timezone ?? '',
      row.location ?? '',
      row.preferredChannel,
      row.influence,
      row.relationship,
      row.summary,
      joinList(row.tags),
      joinList(row.phones),
      row.doNotContact ? 'true' : 'false',
      row.consents,
    ],
    row.customFields,
    definitions,
  )
}

export function positionCells(row: ExportPositionRow): readonly string[] {
  return [row.personEmail ?? '', row.companyDomain ?? '', row.title]
}

export function dealCells(
  row: ExportDealRow,
  personEmails: readonly string[],
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.companyDomain ?? '',
      row.stageSlug,
      centsToMoney(row.valueCents),
      row.ownerEmail ?? '',
      row.expectedClose ?? '',
      joinList(personEmails),
      joinList(row.competitors),
      row.risks,
      row.whyWin,
      row.summary,
      joinList(row.tags),
      row.externalId ?? '',
    ],
    row.customFields,
    definitions,
  )
}

export function opportunityCells(
  row: ExportOpportunityRow,
  personEmails: readonly string[],
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.kind,
      row.companyDomain ?? '',
      row.stageSlug,
      row.ownerEmail ?? '',
      row.expectedClose ?? '',
      joinList(personEmails),
      row.summary,
      joinList(row.tags),
    ],
    row.customFields,
    definitions,
  )
}

export function enquiryCells(
  row: ExportEnquiryRow,
  personEmails: readonly string[],
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.source,
      row.companyDomain ?? '',
      row.stageSlug,
      row.ownerEmail ?? '',
      joinList(personEmails),
      row.summary,
      joinList(row.tags),
    ],
    row.customFields,
    definitions,
  )
}

export function partnershipCells(
  row: ExportPartnershipRow,
  personEmails: readonly string[],
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.companyDomain ?? '',
      row.stageSlug,
      row.kind,
      row.nextTouchpoint ?? '',
      row.ownerEmail ?? '',
      row.goals,
      row.successLooksLike,
      joinList(personEmails),
      row.summary,
      joinList(row.tags),
    ],
    row.customFields,
    definitions,
  )
}

export function raiseCells(
  row: ExportRaiseRow,
  personEmails: readonly string[],
  definitions: readonly CustomFieldDefinitionRecord[] = [],
): readonly string[] {
  return withCustomFields(
    [
      row.name,
      row.companyDomain ?? '',
      row.stageSlug,
      row.checkSizeCents === null ? '' : centsToMoney(row.checkSizeCents),
      row.currency ?? '',
      row.thesisFit,
      row.passReason ?? '',
      row.ownerEmail ?? '',
      row.expectedClose ?? '',
      joinList(personEmails),
      row.summary,
      joinList(row.tags),
    ],
    row.customFields,
    definitions,
  )
}

export function customFieldDefinitionRowCells(row: CustomFieldDefinitionRecord): readonly string[] {
  return customFieldDefinitionCells(row)
}

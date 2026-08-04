import { OBJECT_COLUMNS } from '@kelpie/schemas'
import type { ImportObject } from '@kelpie/schemas'

import { centsToMoney } from './mapping.ts'
import type {
  ExportCompanyRow,
  ExportDealRow,
  ExportPersonRow,
  ExportPositionRow,
} from './repository.ts'

/**
 * Records as CSV cells, in the header order of `OBJECT_COLUMNS`.
 *
 * An export writes what an import reads: the stage is its **slug**, which a
 * rename leaves alone, and the deal value is the major unit rather than cents.
 * That is what makes a Kelpie CSV round-trip through the import wizard with the
 * `custom` source and no mapping at all — every header matches a column name
 * exactly.
 *
 * Pure.
 */

/** Pipe-separated, per `import-export.md`. */
function joinList(values: readonly string[]): string {
  return values.join('|')
}

export function headersFor(object: ImportObject): readonly string[] {
  return OBJECT_COLUMNS[object].map((column) => column.key)
}

export function companyCells(row: ExportCompanyRow): readonly string[] {
  return [
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
  ]
}

export function personCells(row: ExportPersonRow): readonly string[] {
  return [
    row.name,
    row.email ?? '',
    row.timezone ?? '',
    row.location ?? '',
    row.preferredChannel,
    row.influence,
    row.relationship,
    row.summary,
    joinList(row.tags),
    joinList(row.phones),
  ]
}

export function positionCells(row: ExportPositionRow): readonly string[] {
  return [row.personEmail ?? '', row.companyDomain ?? '', row.title]
}

export function dealCells(row: ExportDealRow, personEmails: readonly string[]): readonly string[] {
  return [
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
  ]
}

import { customFieldObjectTypeForExport } from '@kelpie/schemas'
import type { ExportObject } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { definitionsForObject } from '../custom-fields/repository.ts'
import type { CustomFieldDefinitionRecord } from '../custom-fields/repository.ts'
import { csvLine } from './csv.ts'
import {
  companyCells,
  customFieldDefinitionRowCells,
  dealCells,
  enquiryCells,
  headersFor,
  opportunityCells,
  partnershipCells,
  personCells,
  positionCells,
  raiseCells,
} from './exportRows.ts'
import * as repository from './repository.ts'

/**
 * A whole object as CSV, a page of records at a time.
 *
 * A generator rather than a string, because a workspace's records do not have to
 * fit in memory to be downloaded and `import-export.md` says the endpoint
 * streams. The route pipes this straight into the response.
 *
 * Paging is a keyset on `id`. Ids are ULIDs, so that is creation order, and
 * unlike an offset it cannot skip or repeat a record when one is written while
 * the download is in flight.
 */

/** Reads one page and reports where the next starts. */
interface Pager<TRow extends { readonly id: string }> {
  read(after: string): Promise<TRow[]>
  cells(rows: readonly TRow[]): Promise<readonly (readonly string[])[]>
}

async function* pageThrough<TRow extends { readonly id: string }>(
  pager: Pager<TRow>,
): AsyncGenerator<string> {
  let after = ''

  for (;;) {
    const rows = await pager.read(after)

    if (rows.length === 0) {
      return
    }

    for (const cells of await pager.cells(rows)) {
      yield csvLine(cells)
    }

    const last = rows.at(-1)

    if (last === undefined || rows.length < repository.EXPORT_PAGE) {
      return
    }

    after = last.id
  }
}

async function linkedPersonEmailCells<T extends { readonly id: string }>(
  db: Database,
  workspaceId: string,
  targetType: string,
  rows: readonly T[],
  toCells: (row: T, personEmails: readonly string[]) => readonly string[],
): Promise<readonly (readonly string[])[]> {
  const emails = await repository.readLinkedPersonEmails(
    db,
    workspaceId,
    targetType,
    rows.map((row) => row.id),
  )

  return rows.map((row) => toCells(row, emails.get(row.id) ?? []))
}

async function customFieldDefinitionsFor(
  db: Database,
  workspaceId: string,
  object: ExportObject,
): Promise<readonly CustomFieldDefinitionRecord[]> {
  const objectType = customFieldObjectTypeForExport(object)

  if (objectType === null) {
    return []
  }

  return definitionsForObject(db, workspaceId, objectType)
}

export async function* streamExport(
  db: Database,
  workspaceId: string,
  object: ExportObject,
): AsyncGenerator<string> {
  if (object === 'custom_fields') {
    yield csvLine(headersFor(object))

    yield* pageThrough({
      read: (after) => repository.readCustomFieldDefinitions(db, workspaceId, after),
      cells: (rows) => Promise.resolve(rows.map(customFieldDefinitionRowCells)),
    })

    return
  }

  const definitions = await customFieldDefinitionsFor(db, workspaceId, object)

  yield csvLine(headersFor(object, definitions))

  switch (object) {
    case 'companies':
      yield* pageThrough({
        read: (after) => repository.readCompanies(db, workspaceId, after),
        cells: (rows) => Promise.resolve(rows.map((row) => companyCells(row, definitions))),
      })
      return
    case 'people':
      yield* pageThrough({
        read: (after) => repository.readPeople(db, workspaceId, after),
        cells: (rows) => Promise.resolve(rows.map((row) => personCells(row, definitions))),
      })
      return
    case 'positions':
      yield* pageThrough({
        read: (after) => repository.readPositions(db, workspaceId, after),
        cells: (rows) => Promise.resolve(rows.map(positionCells)),
      })
      return
    case 'deals':
      yield* pageThrough({
        read: (after) => repository.readDeals(db, workspaceId, after),
        cells: (rows) =>
          linkedPersonEmailCells(db, workspaceId, 'deal', rows, (row, personEmails) =>
            dealCells(row, personEmails, definitions),
          ),
      })
      return
    case 'opportunities':
      yield* pageThrough({
        read: (after) => repository.readOpportunities(db, workspaceId, after),
        cells: (rows) =>
          linkedPersonEmailCells(db, workspaceId, 'opportunity', rows, (row, personEmails) =>
            opportunityCells(row, personEmails, definitions),
          ),
      })
      return
    case 'enquiries':
      yield* pageThrough({
        read: (after) => repository.readEnquiries(db, workspaceId, after),
        cells: (rows) =>
          linkedPersonEmailCells(db, workspaceId, 'enquiry', rows, (row, personEmails) =>
            enquiryCells(row, personEmails, definitions),
          ),
      })
      return
    case 'partnerships':
      yield* pageThrough({
        read: (after) => repository.readPartnerships(db, workspaceId, after),
        cells: (rows) =>
          linkedPersonEmailCells(db, workspaceId, 'partnership', rows, (row, personEmails) =>
            partnershipCells(row, personEmails, definitions),
          ),
      })
      return
    case 'raises':
      yield* pageThrough({
        read: (after) => repository.readRaises(db, workspaceId, after),
        cells: (rows) =>
          linkedPersonEmailCells(db, workspaceId, 'raise', rows, (row, personEmails) =>
            raiseCells(row, personEmails, definitions),
          ),
      })
      return
  }
}

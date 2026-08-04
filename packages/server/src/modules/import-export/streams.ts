import type { ImportObject } from '@kelpie/schemas'

import type { Database } from '../../lib/database.ts'
import { csvLine } from './csv.ts'
import { companyCells, dealCells, headersFor, personCells, positionCells } from './exportRows.ts'
import * as repository from './repository.ts'

/**
 * A whole object as CSV, a page of records at a time.
 *
 * A generator rather than a string, because a workspace's deals do not have to
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

/** The rows of one page, all their people in one query rather than one per deal. */
async function dealPage(
  db: Database,
  rows: readonly repository.ExportDealRow[],
): Promise<readonly (readonly string[])[]> {
  const emails = await repository.readDealPersonEmails(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) => dealCells(row, emails.get(row.id) ?? []))
}

export async function* streamExport(
  db: Database,
  workspaceId: string,
  object: ImportObject,
): AsyncGenerator<string> {
  yield csvLine(headersFor(object))

  switch (object) {
    case 'companies':
      yield* pageThrough({
        read: (after) => repository.readCompanies(db, workspaceId, after),
        cells: (rows) => Promise.resolve(rows.map(companyCells)),
      })
      return
    case 'people':
      yield* pageThrough({
        read: (after) => repository.readPeople(db, workspaceId, after),
        cells: (rows) => Promise.resolve(rows.map(personCells)),
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
        cells: (rows) => dealPage(db, rows),
      })
      return
  }
}

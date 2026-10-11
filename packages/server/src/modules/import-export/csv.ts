import { createHash } from 'node:crypto'

import { MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from '@kelpie/schemas'

/**
 * RFC 4180 CSV, read and written.
 *
 * Ported from `mockups/src/data/importExport.ts` with two corrections. A blank
 * line no longer shifts the numbering of every row after it, because a row
 * number is what an error message points the user at. And a file whose header
 * row repeats a name is refused rather than silently read as its last
 * occurrence, because a `column_map` names a header and there would be no way to
 * say which of the two it meant.
 *
 * A written cell that a spreadsheet would run as a formula gets an apostrophe
 * in front, and a read cell loses it again. `neutraliseFormula` has the rule.
 *
 * Pure: no I/O, no clock. The whole of it is unit-tested.
 */

/**
 * The digest a job keeps instead of the file.
 *
 * A dry run records this, and the commit that carries the file back is checked
 * against it. Storing 64 characters rather than up to ten megabytes is the
 * point: a forecast nobody committed should not cost a workspace the file.
 *
 * Not a security control. It answers "is this the file I forecast", not "who
 * sent it", so a plain digest is right and `lib/tokens.ts` — which is about
 * bearer secrets — is not the place for it.
 */
export function fileDigest(csv: string): string {
  return createHash('sha256').update(csv, 'utf8').digest('hex')
}

export interface CsvRow {
  /** The line in the file, counting the header as line 1. */
  readonly number: number
  /**
   * Source header → cell. Cells are trimmed, after the apostrophe an export put
   * in front of a formula is removed; a short row's missing cells are `''`.
   */
  readonly values: Readonly<Record<string, string>>
}

export interface ParsedCsv {
  readonly headers: readonly string[]
  readonly rows: readonly CsvRow[]
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvFormatError'
  }
}

/** A leading byte-order mark, which a spreadsheet export routinely writes. */
const BYTE_ORDER_MARK = /^﻿/u

/** What `parseCsv` refuses to read past. Injected so a test can use small numbers. */
export interface CsvLimits {
  readonly maxRows: number
  readonly maxColumns: number
}

const DEFAULT_LIMITS: CsvLimits = { maxRows: MAX_IMPORT_ROWS, maxColumns: MAX_IMPORT_COLUMNS }

interface PhysicalRow {
  /** The record's place in the file, counting the header as 1. */
  readonly number: number
  readonly cells: readonly string[]
}

/**
 * A cell a spreadsheet reads as a formula: `=`, `+`, `-`, `@`, a tab or a
 * carriage return first. Apostrophes before that character count too, so a
 * value that already starts `'=` gets one more and reads back as itself.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/u

/**
 * A sign, then digits and the punctuation of a phone number or a negative
 * number. With no letter it cannot name a function, a cell or a program, so
 * `+61 400 000 000` and `-12.5` stay as they are. `+1+1` has a second `+` and
 * does not match.
 */
const SIGNED_NUMBER = /^[+-][0-9 ().-]*$/u

/**
 * The one header a row cannot hold.
 *
 * A row is an object keyed by header. An assignment to `__proto__` does not
 * store the cell, and a read of it gives `Object.prototype` where a cell
 * should be. Every other name on `Object.prototype`, such as `constructor`, is
 * stored as the row's own property and is a header like any other.
 */
const UNSTORABLE_HEADER = '__proto__'

/** A cell `neutraliseFormula` wrote: at least one apostrophe, then a formula character. */
const NEUTRALISED_FORMULA = /^'+[=+\-@\t\r]/u

/**
 * Puts an apostrophe in front of a cell that a spreadsheet would run.
 *
 * A spreadsheet evaluates a CSV cell that starts with a formula character, and
 * a formula can fetch a URL or start a program. A record's name can be what a
 * stranger typed into a public form, so an export cannot trust it. With an
 * apostrophe first, the spreadsheet reads the cell as text.
 */
function neutraliseFormula(value: string): string {
  return FORMULA_START.test(value) && !SIGNED_NUMBER.test(value) ? `'${value}` : value
}

/**
 * The reverse of `neutraliseFormula`: removes the one apostrophe it added.
 *
 * It looks at the cell as the file holds it, before any trim, because that is
 * where an export puts the apostrophe. A cell with white space in front of the
 * apostrophe was not written by `neutraliseFormula` and keeps it.
 */
function restoreFormula(cell: string): string {
  return NEUTRALISED_FORMULA.test(cell) ? cell.slice(1) : cell
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim().length === 0)
}

/**
 * Splits the text into physical cells, honouring quoted fields.
 *
 * A quote inside a quoted field is doubled (`""`), and a newline inside one does
 * not end the record — which is why this cannot be a `split` on lines.
 *
 * The limits apply here, while the text is read, and not afterwards: a file of
 * ten megabytes of commas or of line breaks is otherwise millions of cells or
 * of rows in memory before anything counts them. A blank data row is dropped as
 * it is read, and still counts towards the numbering. A record keeps at most
 * one cell more than `maxColumns`, which is enough to see that a header row is
 * too wide, and a data cell past the last header has nowhere to go anyway.
 *
 * @throws CsvFormatError when the file has more than `maxRows` data rows.
 */
function splitRows(text: string, limits: CsvLimits): PhysicalRow[] {
  const rows: PhysicalRow[] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let number = 0
  const input = text.replace(BYTE_ORDER_MARK, '')

  function endCell(): void {
    if (row.length <= limits.maxColumns) {
      row.push(cell)
    }

    cell = ''
  }

  function endRow(): void {
    endCell()
    number += 1

    // The header row is kept even when blank, so the caller can say so.
    if (number === 1 || !isBlank(row)) {
      // The header is not a data row, hence the `+ 1`.
      if (rows.length === limits.maxRows + 1) {
        throw new CsvFormatError(`A file may carry at most ${String(limits.maxRows)} rows`)
      }

      rows.push({ number, cells: row })
    }

    row = []
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]

    if (inQuotes) {
      if (character !== '"') {
        cell += character
        continue
      }

      if (input[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        inQuotes = false
      }

      continue
    }

    if (character === '"') {
      inQuotes = true
      continue
    }

    if (character === ',') {
      endCell()
      continue
    }

    if (character === '\n') {
      endRow()
      continue
    }

    // A bare CR belongs to the CRLF that ends a line; a lone one is not a cell.
    if (character === '\r') {
      continue
    }

    cell += character
  }

  if (cell.length > 0 || row.length > 0) {
    endRow()
  }

  return rows
}

/**
 * @throws CsvFormatError when the file has no header row, when a header is
 *   blank, when two headers are the same, when a header is `__proto__`, or
 *   when the file is over a limit. The first three make a `column_map`
 *   unanswerable rather than merely inconvenient. The fourth is a column no
 *   row can hold.
 */
export function parseCsv(text: string, limits: CsvLimits = DEFAULT_LIMITS): ParsedCsv {
  const [headerRow, ...dataRows] = splitRows(text, limits)

  if (headerRow === undefined || isBlank(headerRow.cells)) {
    throw new CsvFormatError('The file has no header row')
  }

  if (headerRow.cells.length > limits.maxColumns) {
    throw new CsvFormatError(`A file may have at most ${String(limits.maxColumns)} columns`)
  }

  // Not passed through `restoreFormula`. A `column_map` names a header as the
  // file wrote it, and no header an export writes starts with a formula
  // character: they are column keys and custom field keys.
  const headers = headerRow.cells.map((header) => header.trim())
  const blank = headers.findIndex((header) => header.length === 0)

  if (blank >= 0) {
    throw new CsvFormatError(`Column ${String(blank + 1)} of the header row has no name`)
  }

  const seen = new Set<string>()

  for (const header of headers) {
    if (seen.has(header)) {
      throw new CsvFormatError(`The header "${header}" appears more than once`)
    }

    seen.add(header)
  }

  if (seen.has(UNSTORABLE_HEADER)) {
    throw new CsvFormatError(`A column cannot be headed "${UNSTORABLE_HEADER}"`)
  }

  const rows = dataRows.map(({ number, cells }): CsvRow => {
    const values: Record<string, string> = {}

    headers.forEach((header, column) => {
      values[header] = restoreFormula(cells[column] ?? '').trim()
    })

    return { number, values }
  })

  return { headers, rows }
}

/**
 * One cell as it goes into the file. The formula rule is applied here, before
 * the quoting, so that no caller of `csvLine` can leave it out.
 */
function escapeCell(value: string): string {
  const safe = neutraliseFormula(value)

  return /["\n\r,]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe
}

/** One CSV line, terminated. Rows are written a line at a time so an export can stream. */
export function csvLine(cells: readonly string[]): string {
  return `${cells.map(escapeCell).join(',')}\n`
}

export function serialiseCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, ...rows].map(csvLine).join('')
}

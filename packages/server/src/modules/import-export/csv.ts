import { createHash } from 'node:crypto'

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
  /** Source header → cell. Cells are trimmed; a short row's missing cells are `''`. */
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

/**
 * Splits the text into physical cells, honouring quoted fields.
 *
 * A quote inside a quoted field is doubled (`""`), and a newline inside one does
 * not end the record — which is why this cannot be a `split` on lines.
 */
function splitRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const input = text.replace(BYTE_ORDER_MARK, '')

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
      row.push(cell)
      cell = ''
      continue
    }

    if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    // A bare CR belongs to the CRLF that ends a line; a lone one is not a cell.
    if (character === '\r') {
      continue
    }

    cell += character
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((cell) => cell.trim().length === 0)
}

/**
 * @throws CsvFormatError when the file has no header row, when a header is
 *   blank, or when two headers are the same. Each of those makes a `column_map`
 *   unanswerable rather than merely inconvenient.
 */
export function parseCsv(text: string): ParsedCsv {
  const [headerCells, ...dataCells] = splitRows(text)

  if (headerCells === undefined || isBlank(headerCells)) {
    throw new CsvFormatError('The file has no header row')
  }

  const headers = headerCells.map((header) => header.trim())
  const blank = headers.findIndex((header) => header.length === 0)

  if (blank >= 0) {
    throw new CsvFormatError(`Column ${String(blank + 1)} of the header row has no name`)
  }

  const duplicate = headers.find((header, index) => headers.indexOf(header) !== index)

  if (duplicate !== undefined) {
    throw new CsvFormatError(`The header "${duplicate}" appears more than once`)
  }

  const rows: CsvRow[] = []

  dataCells.forEach((cells, index) => {
    if (isBlank(cells)) {
      return
    }

    const values: Record<string, string> = {}

    headers.forEach((header, column) => {
      values[header] = (cells[column] ?? '').trim()
    })

    // +2, not +1: the header is line 1 and this index counts from the line after.
    rows.push({ number: index + 2, values })
  })

  return { headers, rows }
}

function escapeCell(value: string): string {
  return /["\n\r,]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/** One CSV line, terminated. Rows are written a line at a time so an export can stream. */
export function csvLine(cells: readonly string[]): string {
  return `${cells.map(escapeCell).join(',')}\n`
}

export function serialiseCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, ...rows].map(csvLine).join('')
}

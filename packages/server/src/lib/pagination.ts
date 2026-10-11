import { asc, desc, sql } from 'drizzle-orm'
import type { Column, SQL } from 'drizzle-orm'
import { z } from 'zod'

import { isoDateSchema } from './dates.ts'
import { AppError } from './errors.ts'

/**
 * Cursor pagination: `?limit=` and `?cursor=`, an opaque cursor, and
 * `{ data, next_cursor }` on the wire.
 *
 * The cursor is a keyset rather than an offset. It carries the sort value and id
 * of the last row on the page, so a page boundary stays put when rows are
 * inserted or deleted underneath a client. Offsets skip and repeat rows when that
 * happens, which for a CRM that agents write to is not a rare case.
 *
 * A cursor is bound to the sort it was issued under. Reusing one against a
 * different `?sort=` is a client bug, and it is reported as one rather than
 * silently paging through a different order.
 *
 * A cursor is also a string the caller sends, so the caller can write one.
 * Its position goes to Postgres as a parameter of the column's type. Each
 * `parse` below therefore refuses a value that Postgres cannot compare with
 * that type. Such a value would answer `500` for what is a request error.
 */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

/** A field a list may be ordered by, and how its value survives a round trip through a cursor. */
export interface SortableField<TRecord> {
  readonly column: Column
  /** Reads the cursor value out of the last row of a page. */
  readonly valueOf: (record: TRecord) => string
  /** Turns that string back into something comparable against the column. */
  readonly parse: (value: string) => Date | string | number
}

/** The documented sort fields of one resource, keyed by their wire name. */
export type SortableFields<TRecord> = Readonly<Record<string, SortableField<TRecord>>>

/** Where the previous page stopped. */
export interface CursorPosition {
  readonly value: Date | string | number
  readonly id: string
}

export interface ListWindow<TRecord> {
  /** How many rows the caller asked for. */
  readonly limit: number
  /** What to ask the database for: one more than `limit`, to detect a next page. */
  readonly fetchLimit: number
  /** The canonical sort spec, `-created_at` style. Cursors are bound to it. */
  readonly sort: string
  readonly field: SortableField<TRecord>
  readonly descending: boolean
  readonly position: CursorPosition | undefined
}

export interface Page<TRecord> {
  readonly items: readonly TRecord[]
  readonly nextCursor: string | null
}

export interface ListQueryParameters {
  readonly limit?: string | undefined
  readonly sort?: string | undefined
  readonly cursor?: string | undefined
}

/**
 * Text that Postgres can take as a parameter. U+0000 is the one character a
 * `text` value cannot hold, and Postgres refuses a parameter that has it.
 * Every other character a JavaScript string can hold arrives as valid UTF-8:
 * the driver writes half of a surrogate pair as U+FFFD.
 */
const storableText = z.string().refine((text) => !text.includes('\u0000'))

/** The cursor payload. It is client-supplied, so it is parsed, never trusted. */
const cursorSchema = z.strictObject({
  sort: z.string().min(1),
  value: storableText,
  id: storableText.min(1),
})

/** The range of a Postgres `integer` column, which is 32 bits wide. */
const MIN_INTEGER = -2_147_483_648
const MAX_INTEGER = 2_147_483_647

/**
 * The first and the last millisecond of the years 1 to 9999.
 *
 * The driver sends a `Date` as `toISOString()`. For a year outside 0 to 9999
 * that text has a sign and six digits for the year, which Postgres does not
 * read, and Postgres has no year 0. So this is the range that both sides
 * agree on. It is well inside what a `timestamptz` column and a `Date` hold.
 */
const MIN_TIMESTAMP = Date.parse('0001-01-01T00:00:00.000Z')
const MAX_TIMESTAMP = Date.parse('9999-12-31T23:59:59.999Z')

function invalidCursor(reason: string): AppError {
  return AppError.validationFailed('That cursor is not one this API issued', [
    { field: 'cursor', message: reason },
  ])
}

/**
 * A sort on a `text` column. Any text is a position, so there is nothing to
 * parse: `decodeCursor` has refused the one character Postgres cannot take.
 * A column of another type needs its own sort, because Postgres parses the
 * position as that type.
 */
export function textSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => string,
): SortableField<TRecord> {
  return { column, valueOf, parse: (value) => value }
}

/** A sort on an `integer` column. Not for `bigint`: the range is that of 32 bits. */
export function integerSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => number,
): SortableField<TRecord> {
  return {
    column,
    valueOf: (record) => String(valueOf(record)),
    parse: (value) => {
      const parsed = Number(value)

      if (!Number.isInteger(parsed)) {
        throw invalidCursor('Its position is not a whole number')
      }

      if (parsed < MIN_INTEGER || parsed > MAX_INTEGER) {
        throw invalidCursor('Its position is too large or too small')
      }

      return parsed
    },
  }
}

/**
 * A sort on a `date` column that the record holds as `YYYY-MM-DD`.
 *
 * @throws AppError 422 from `parse` for text in another form, for a day that
 *   does not exist, and for year 0, which `isoDateSchema` accepts and
 *   Postgres does not have.
 */
export function dateSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => string,
): SortableField<TRecord> {
  return {
    column,
    valueOf,
    parse: (value) => {
      if (!isoDateSchema.safeParse(value).success || value.startsWith('0000-')) {
        throw invalidCursor('Its position is not a date')
      }

      return value
    },
  }
}

/** A sort on a `timestamptz` column. A position is an instant in the years 1 to 9999. */
export function timestampSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => Date,
): SortableField<TRecord> {
  return {
    column,
    valueOf: (record) => valueOf(record).toISOString(),
    parse: (value) => {
      const parsed = new Date(value)
      const time = parsed.getTime()

      if (Number.isNaN(time)) {
        throw invalidCursor('Its position is not a timestamp')
      }

      if (time < MIN_TIMESTAMP || time > MAX_TIMESTAMP) {
        throw invalidCursor('Its position is outside the years 1 to 9999')
      }

      return parsed
    },
  }
}

function encodeCursor(sort: string, value: string, id: string): string {
  return Buffer.from(JSON.stringify({ sort, value, id }), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): z.infer<typeof cursorSchema> {
  let payload: unknown

  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    // Base64 and JSON both refuse the same way here: the string did not come
    // from `encodeCursor`. The client cannot act on which of the two failed.
    throw invalidCursor('It is not readable')
  }

  const parsed = cursorSchema.safeParse(payload)

  if (!parsed.success) {
    throw invalidCursor('It does not carry a position')
  }

  return parsed.data
}

/**
 * Reads `?limit=` against the allowed range.
 *
 * Exported for the endpoints that take the same parameter without being paged
 * lists. The dashboard is the case: it caps several embedded lists at once and
 * issues no cursor, but the ceiling a caller may ask for is the same one.
 *
 * @throws AppError 422 for anything but a whole number in range.
 */
export function readPageSize(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE
  }

  const limit = Number(raw)

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw AppError.validationFailed('That page size is out of range', [
      { field: 'limit', message: `Use a whole number from 1 to ${String(MAX_PAGE_SIZE)}` },
    ])
  }

  return limit
}

/**
 * Reads `?limit=`, `?sort=` and `?cursor=` into a window a repository can apply.
 *
 * @param defaultSort The resource's own default, `-created_at` style. Naming a
 *   field the resource does not declare is a programming error, not a request
 *   error, so it throws rather than producing a 422.
 * @throws AppError 422 for an out-of-range limit, an undocumented sort field, or
 *   a cursor that is unreadable or belongs to a different sort order.
 */
export function readListWindow<TRecord>(
  query: ListQueryParameters,
  fields: SortableFields<TRecord>,
  defaultSort: string,
): ListWindow<TRecord> {
  const sort = query.sort ?? defaultSort
  const descending = sort.startsWith('-')
  const name = descending ? sort.slice(1) : sort
  const field = fields[name]

  if (field === undefined) {
    const documented = Object.keys(fields).sort().join(', ')

    if (query.sort === undefined) {
      throw new Error(`Default sort "${defaultSort}" is not one of: ${documented}`)
    }

    throw AppError.validationFailed('That sort field is not available on this resource', [
      { field: 'sort', message: `Sort by one of: ${documented}` },
    ])
  }

  const position = ((): CursorPosition | undefined => {
    if (query.cursor === undefined) {
      return undefined
    }

    const decoded = decodeCursor(query.cursor)

    if (decoded.sort !== sort) {
      throw invalidCursor(`It was issued for sort=${decoded.sort}`)
    }

    return { value: field.parse(decoded.value), id: decoded.id }
  })()

  const limit = readPageSize(query.limit)

  return { limit, fetchLimit: limit + 1, sort, field, descending, position }
}

/**
 * The keyset predicate: everything after the cursor's row in the window's order.
 *
 * Values go through `sql.param` with their own column as the encoder. A bare
 * `${value}` in a template reaches the driver unconverted, and postgres.js has no
 * column to infer from, so a `Date` arrives where it wants a string.
 *
 * @returns undefined on the first page, where there is nothing to seek past.
 */
export function keysetCondition<TRecord>(
  window: ListWindow<TRecord>,
  idColumn: Column,
): SQL | undefined {
  if (window.position === undefined) {
    return undefined
  }

  const { column } = window.field
  const after = sql.param(window.position.value, column)
  const afterId = sql.param(window.position.id, idColumn)

  return window.descending
    ? sql`(${column} < ${after} or (${column} = ${after} and ${idColumn} < ${afterId}))`
    : sql`(${column} > ${after} or (${column} = ${after} and ${idColumn} > ${afterId}))`
}

/**
 * The ordering, id included. Without the id tiebreak two rows sharing a sort
 * value could straddle a page boundary in either order, and one of them would be
 * lost or repeated.
 */
export function orderByWindow<TRecord>(window: ListWindow<TRecord>, idColumn: Column): SQL[] {
  const direction = window.descending ? desc : asc

  return [direction(window.field.column), direction(idColumn)]
}

/**
 * Trims the extra row a repository fetched and turns it into a next cursor.
 *
 * @param rows Up to `window.fetchLimit` rows, in the window's order.
 */
export function toPage<TRecord>(
  rows: readonly TRecord[],
  window: ListWindow<TRecord>,
  idOf: (record: TRecord) => string,
): Page<TRecord> {
  if (rows.length < window.fetchLimit) {
    return { items: rows, nextCursor: null }
  }

  const items = rows.slice(0, window.limit)
  const last = items.at(-1)

  if (last === undefined) {
    throw new Error('unreachable: a full page cannot be empty')
  }

  return { items, nextCursor: encodeCursor(window.sort, window.field.valueOf(last), idOf(last)) }
}

/**
 * Re-shapes the items of a page, leaving the cursor alone.
 *
 * A service pages over stored rows and answers with views, and the cursor is
 * built from the row it came from, not from what the caller is handed back.
 */
export function mapPage<TFrom, TTo>(page: Page<TFrom>, render: (item: TFrom) => TTo): Page<TTo> {
  return { items: page.items.map(render), nextCursor: page.nextCursor }
}

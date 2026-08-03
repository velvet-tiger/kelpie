import { asc, desc, sql } from 'drizzle-orm'
import type { Column, SQL } from 'drizzle-orm'
import { z } from 'zod'

import { AppError } from './errors.ts'

/**
 * Cursor pagination from `api.md`: `?limit=` and `?cursor=`, an opaque cursor,
 * and `{ data, next_cursor }` on the wire.
 *
 * The cursor is a keyset rather than an offset. It carries the sort value and id
 * of the last row on the page, so a page boundary stays put when rows are
 * inserted or deleted underneath a client. Offsets skip and repeat rows when that
 * happens, which for a CRM that agents write to is not a rare case.
 *
 * A cursor is bound to the sort it was issued under. Reusing one against a
 * different `?sort=` is a client bug, and it is reported as one rather than
 * silently paging through a different order.
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

/** The cursor payload. It is client-supplied, so it is parsed, never trusted. */
const cursorSchema = z.strictObject({
  sort: z.string().min(1),
  value: z.string(),
  id: z.string().min(1),
})

function invalidCursor(reason: string): AppError {
  return AppError.validationFailed('That cursor is not one this API issued', [
    { field: 'cursor', message: reason },
  ])
}

export function textSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => string,
): SortableField<TRecord> {
  return { column, valueOf, parse: (value) => value }
}

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

      return parsed
    },
  }
}

export function timestampSort<TRecord>(
  column: Column,
  valueOf: (record: TRecord) => Date,
): SortableField<TRecord> {
  return {
    column,
    valueOf: (record) => valueOf(record).toISOString(),
    parse: (value) => {
      const parsed = new Date(value)

      if (Number.isNaN(parsed.getTime())) {
        throw invalidCursor('Its position is not a timestamp')
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

function readLimit(raw: string | undefined): number {
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

  const limit = readLimit(query.limit)

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

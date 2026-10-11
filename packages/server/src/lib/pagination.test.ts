import { date, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { AppError } from './errors.ts'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  dateSort,
  integerSort,
  mapPage,
  readListWindow,
  textSort,
  timestampSort,
  toPage,
} from './pagination.ts'
import type { SortableFields } from './pagination.ts'

/**
 * A table of its own rather than a real one: these are the rules of paging, and
 * they should not change because a module renamed a column.
 */
const widgets = pgTable('widgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  dueOn: date('due_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
})

interface Widget {
  readonly id: string
  readonly name: string
  readonly position: number
  readonly dueOn: string
  readonly createdAt: Date
}

const WIDGET_SORTS: SortableFields<Widget> = {
  name: textSort(widgets.name, (widget) => widget.name),
  position: integerSort(widgets.position, (widget) => widget.position),
  due_on: dateSort(widgets.dueOn, (widget) => widget.dueOn),
  created_at: timestampSort(widgets.createdAt, (widget) => widget.createdAt),
}

function widget(id: string, name: string, createdAt = '2026-08-02T01:00:00.000Z'): Widget {
  return { id, name, position: 0, dueOn: '2026-08-02', createdAt: new Date(createdAt) }
}

/** A cursor as `toPage` encodes one, with a position the caller chose. */
function forgedCursor(sort: string, value: string, id = 'w1'): string {
  return Buffer.from(JSON.stringify({ sort, value, id }), 'utf8').toString('base64url')
}

/** The position `readListWindow` reads from a forged cursor for one sort. */
function positionOf(sort: string, value: string, id = 'w1'): () => unknown {
  return () => readListWindow({ sort, cursor: forgedCursor(sort, value, id) }, WIDGET_SORTS, '-created_at').position
}

function statusOf(run: () => unknown): number {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof AppError) {
      return error.status
    }

    throw error
  }

  throw new Error('Expected the call to throw')
}

describe('readListWindow', () => {
  it('defaults to the resource sort and the documented page size', () => {
    const window = readListWindow({}, WIDGET_SORTS, '-created_at')

    expect(window.limit).toBe(DEFAULT_PAGE_SIZE)
    expect(window.fetchLimit).toBe(DEFAULT_PAGE_SIZE + 1)
    expect(window.sort).toBe('-created_at')
    expect(window.descending).toBe(true)
    expect(window.position).toBeUndefined()
  })

  it('reads a leading minus as descending', () => {
    expect(readListWindow({ sort: 'name' }, WIDGET_SORTS, '-created_at').descending).toBe(false)
    expect(readListWindow({ sort: '-name' }, WIDGET_SORTS, '-created_at').descending).toBe(true)
  })

  it('refuses a sort field the resource does not document', () => {
    expect(statusOf(() => readListWindow({ sort: 'colour' }, WIDGET_SORTS, '-created_at'))).toBe(422)
  })

  it('refuses a limit outside the documented range', () => {
    const parse = (limit: string) => () => readListWindow({ limit }, WIDGET_SORTS, '-created_at')

    expect(statusOf(parse('0'))).toBe(422)
    expect(statusOf(parse(String(MAX_PAGE_SIZE + 1)))).toBe(422)
    expect(statusOf(parse('2.5'))).toBe(422)
    expect(statusOf(parse('ten'))).toBe(422)
    expect(statusOf(parse(''))).toBe(422)
    expect(readListWindow({ limit: String(MAX_PAGE_SIZE) }, WIDGET_SORTS, '-created_at').limit).toBe(
      MAX_PAGE_SIZE,
    )
  })

  /** A default naming a field the resource does not have is a bug in the resource, not in the request. */
  it('throws rather than answering 422 when the resource default is wrong', () => {
    expect(() => readListWindow({}, WIDGET_SORTS, '-colour')).toThrow(/not one of/u)
  })

  it('refuses a cursor it did not issue', () => {
    const parse = (cursor: string) => () => readListWindow({ cursor }, WIDGET_SORTS, '-created_at')

    expect(statusOf(parse('nonsense'))).toBe(422)
    expect(statusOf(parse(Buffer.from('{"not":"a cursor"}').toString('base64url')))).toBe(422)
  })
})

// A cursor is a string the caller sends, so each position in it must be one
// that Postgres can compare with the column. A value that Postgres refuses
// would answer 500 for what is a request error.
describe('a forged cursor', () => {
  it('refuses a NUL character in the value or in the id, which Postgres cannot hold in text', () => {
    expect(statusOf(positionOf('name', 'One\u0000'))).toBe(422)
    expect(statusOf(positionOf('name', '\u0000'))).toBe(422)
    expect(statusOf(positionOf('name', 'One', 'w1\u0000'))).toBe(422)
    expect(statusOf(positionOf('position', '1', '\u0000w1'))).toBe(422)
    expect(statusOf(positionOf('created_at', '2026-08-02T01:00:00.000Z', 'w\u00001'))).toBe(422)
  })

  it('keeps any other text position, an empty one and one with no ASCII in it included', () => {
    expect(positionOf('name', '')()).toEqual({ value: '', id: 'w1' })
    expect(positionOf('name', 'Zoë 東京 \t\n')()).toEqual({ value: 'Zoë 東京 \t\n', id: 'w1' })
  })

  it('reads a whole number in the range of a Postgres integer', () => {
    expect(positionOf('position', '0')()).toEqual({ value: 0, id: 'w1' })
    expect(positionOf('position', '7')()).toEqual({ value: 7, id: 'w1' })
    expect(positionOf('position', '-2147483648')()).toEqual({ value: -2147483648, id: 'w1' })
    expect(positionOf('position', '2147483647')()).toEqual({ value: 2147483647, id: 'w1' })
  })

  it('refuses a number that is not whole, or is outside the range of a Postgres integer', () => {
    for (const value of [
      'abc',
      '1.5',
      'NaN',
      'Infinity',
      '2147483648',
      '-2147483649',
      '99999999999',
      '-99999999999',
      '1e20',
      '1e308',
      '9007199254740993',
    ]) {
      expect(statusOf(positionOf('position', value)), value).toBe(422)
    }
  })

  it('reads a timestamp from year 1 to year 9999', () => {
    for (const value of ['0001-01-01T00:00:00.000Z', '2026-08-02T01:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      expect(positionOf('created_at', value)(), value).toEqual({ value: new Date(value), id: 'w1' })
    }
  })

  it('refuses a timestamp that is not one, or is outside year 1 to year 9999', () => {
    for (const value of [
      'yesterday',
      '',
      '-271821-04-20T00:00:00.000Z',
      '-000001-12-31T23:59:59.999Z',
      '0000-01-01T00:00:00.000Z',
      '0000-12-31T23:59:59.999Z',
      '+010000-01-01T00:00:00.000Z',
      '+275760-09-13T00:00:00.000Z',
    ]) {
      expect(statusOf(positionOf('created_at', value)), value).toBe(422)
    }
  })

  it('reads a date that exists, from year 1 to year 9999', () => {
    for (const value of ['0001-01-01', '2024-02-29', '2026-08-02', '9999-12-31']) {
      expect(positionOf('due_on', value)(), value).toEqual({ value, id: 'w1' })
    }
  })

  it('refuses a date in another form, a day that does not exist, and year 0', () => {
    for (const value of [
      'abc',
      '',
      '2026-02-30',
      '2026-13-01',
      '2025-02-29',
      '0000-01-01',
      '10000-01-01',
      '2026-08-02T00:00:00Z',
      '20260802',
      'today',
      'infinity',
    ]) {
      expect(statusOf(positionOf('due_on', value)), value).toBe(422)
    }
  })
})

describe('toPage', () => {
  it('reports no next page when the extra row is absent', () => {
    const window = readListWindow({ limit: '2' }, WIDGET_SORTS, '-created_at')

    const page = toPage([widget('w1', 'One'), widget('w2', 'Two')], window, (row) => row.id)

    expect(page.items).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it('trims the extra row and issues a cursor when it is present', () => {
    const window = readListWindow({ limit: '2' }, WIDGET_SORTS, '-created_at')

    const page = toPage(
      [widget('w1', 'One'), widget('w2', 'Two'), widget('w3', 'Three')],
      window,
      (row) => row.id,
    )

    expect(page.items.map((row) => row.id)).toEqual(['w1', 'w2'])
    expect(page.nextCursor).not.toBeNull()
  })

  it('round-trips its cursor back into the position of the last row', () => {
    const window = readListWindow({ limit: '1', sort: 'name' }, WIDGET_SORTS, '-created_at')
    const page = toPage([widget('w1', 'One'), widget('w2', 'Two')], window, (row) => row.id)

    const next = readListWindow(
      { limit: '1', sort: 'name', cursor: String(page.nextCursor) },
      WIDGET_SORTS,
      '-created_at',
    )

    expect(next.position).toEqual({ value: 'One', id: 'w1' })
  })

  it('round-trips a timestamp position as an instant, not a string', () => {
    const window = readListWindow({ limit: '1' }, WIDGET_SORTS, '-created_at')
    const page = toPage(
      [widget('w1', 'One', '2026-08-02T01:00:00.000Z'), widget('w2', 'Two')],
      window,
      (row) => row.id,
    )

    const next = readListWindow(
      { limit: '1', cursor: String(page.nextCursor) },
      WIDGET_SORTS,
      '-created_at',
    )

    expect(next.position?.value).toEqual(new Date('2026-08-02T01:00:00.000Z'))
  })

  it('refuses its own cursor against a different sort order', () => {
    const window = readListWindow({ limit: '1', sort: 'name' }, WIDGET_SORTS, '-created_at')
    const page = toPage([widget('w1', 'One'), widget('w2', 'Two')], window, (row) => row.id)

    expect(
      statusOf(() =>
        readListWindow({ sort: '-name', cursor: String(page.nextCursor) }, WIDGET_SORTS, '-created_at'),
      ),
    ).toBe(422)
  })
})

describe('mapPage', () => {
  it('re-shapes the items and leaves the cursor alone', () => {
    const page = mapPage({ items: [widget('w1', 'One')], nextCursor: 'abc' }, (row) => row.name)

    expect(page.items).toEqual(['One'])
    expect(page.nextCursor).toBe('abc')
  })
})

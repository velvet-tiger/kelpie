import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { AppError } from './errors.ts'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
})

interface Widget {
  readonly id: string
  readonly name: string
  readonly createdAt: Date
}

const WIDGET_SORTS: SortableFields<Widget> = {
  name: textSort(widgets.name, (widget) => widget.name),
  created_at: timestampSort(widgets.createdAt, (widget) => widget.createdAt),
}

function widget(id: string, name: string, createdAt = '2026-08-02T01:00:00.000Z'): Widget {
  return { id, name, createdAt: new Date(createdAt) }
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

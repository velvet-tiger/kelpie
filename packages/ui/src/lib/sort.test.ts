import { describe, expect, it } from 'vitest'

import { compareValues, serverSortOnly, sortRowsBy } from './sort.ts'

describe('compareValues', () => {
  it('sorts strings case-insensitively with locale rules', () => {
    expect(compareValues('apple', 'Banana')).toBeLessThan(0)
    expect(compareValues('Zebra', 'apple')).toBeGreaterThan(0)
    expect(compareValues('apple', 'apple')).toBe(0)
  })

  it('sorts numbers numerically, not lexicographically', () => {
    expect(compareValues(2, 10)).toBeLessThan(0)
    expect(compareValues(100, 20)).toBeGreaterThan(0)
  })

  it('sorts strings that look like numbers as numbers', () => {
    // `numeric: true` on Intl.Collator keeps "item 2" before "item 10".
    expect(compareValues('item 2', 'item 10')).toBeLessThan(0)
  })

  it('sorts Dates by time', () => {
    const earlier = new Date('2020-01-01T00:00:00Z')
    const later = new Date('2020-06-01T00:00:00Z')

    expect(compareValues(earlier, later)).toBeLessThan(0)
    expect(compareValues(later, earlier)).toBeGreaterThan(0)
  })

  it('sorts booleans with true first', () => {
    expect(compareValues(true, false)).toBeLessThan(0)
    expect(compareValues(false, true)).toBeGreaterThan(0)
  })

  it('always sorts null and undefined last, both ways', () => {
    // null being "last" is a value property, not a direction property, so the
    // sort function reverses the compare result for desc but leaves the null
    // pin alone.
    expect(compareValues(null, 'anything')).toBeGreaterThan(0)
    expect(compareValues('anything', null)).toBeLessThan(0)
    expect(compareValues(undefined, 5)).toBeGreaterThan(0)
    expect(compareValues(5, undefined)).toBeLessThan(0)
    expect(compareValues(null, null)).toBe(0)
  })

  it('treats an empty string as missing', () => {
    // An empty string is "no answer" in the CRM's data model — a summary that
    // was never written. Sorting it alongside "aardvark" would put the blanks
    // first, which reads as broken.
    expect(compareValues('', 'aardvark')).toBeGreaterThan(0)
    expect(compareValues('aardvark', '')).toBeLessThan(0)
  })

  it('sorts arrays by their joined value', () => {
    expect(compareValues(['bug', 'ops'], ['bug', 'perf'])).toBeLessThan(0)
    expect(compareValues([], ['anything'])).toBeGreaterThan(0)
  })
})

describe('serverSortOnly', () => {
  const SERVER_KEYS = ['name', 'created_at', 'updated_at']

  it('returns undefined when nothing is sorted', () => {
    expect(serverSortOnly(undefined, SERVER_KEYS)).toBeUndefined()
  })

  it('forwards a sort the server knows, in either direction', () => {
    expect(serverSortOnly('name', SERVER_KEYS)).toBe('name')
    expect(serverSortOnly('-name', SERVER_KEYS)).toBe('-name')
    expect(serverSortOnly('created_at', SERVER_KEYS)).toBe('created_at')
  })

  it('drops a sort the server does not know (the client will handle it)', () => {
    // The page's `sort` state also drives the DataTable's own sort dispatch,
    // so the server just gets nothing rather than a 422 on a field it never
    // indexed.
    expect(serverSortOnly('influence', SERVER_KEYS)).toBeUndefined()
    expect(serverSortOnly('-summary', SERVER_KEYS)).toBeUndefined()
  })
})

describe('sortRowsBy', () => {
  interface Row {
    readonly id: number
    readonly name: string
  }

  const rows: readonly Row[] = [
    { id: 1, name: 'charlie' },
    { id: 2, name: 'alpha' },
    { id: 3, name: 'bravo' },
  ]

  it('orders rows by the accessor in ascending order', () => {
    expect(sortRowsBy(rows, (row) => row.name, 'asc').map((row) => row.id)).toEqual([2, 3, 1])
  })

  it('orders rows by the accessor in descending order', () => {
    expect(sortRowsBy(rows, (row) => row.name, 'desc').map((row) => row.id)).toEqual([1, 3, 2])
  })

  it('is stable across ties', () => {
    // Two rows both compare equal on `name.length`, so the sort must not swap
    // them — otherwise a second click on the same column would reshuffle
    // equal-length names.
    const withTies: readonly Row[] = [
      { id: 1, name: 'aaa' },
      { id: 2, name: 'bbb' },
      { id: 3, name: 'cc' },
    ]

    expect(sortRowsBy(withTies, (row) => row.name.length, 'asc').map((row) => row.id)).toEqual([
      3, 1, 2,
    ])
  })
})

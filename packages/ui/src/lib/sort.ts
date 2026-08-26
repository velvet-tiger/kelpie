/**
 * Comparators for the DataTable's client-side sort path.
 *
 * The server-side path is a keyset over an indexed column, so a page-local sort
 * is different in kind: it only orders the records the current page holds.
 * Anything on another page keeps the resource's own default order — which is
 * why a "sorted on this page" hint sits under any table sorted this way.
 */

export type SortDirection = 'asc' | 'desc'

/**
 * Returns the sort string that should reach the server, dropping any that
 * names a client-only column. A page holds the active sort as a single string;
 * this lets it pass an unfiltered `sort` to `<DataTable>` (so the header shows
 * an arrow either way) while only forwarding server-sortable choices to its
 * `useX({ sort: serverSortOnly(sort, sortKeys) })` call.
 *
 * `sortKeys` is the set of `Column.sortKey` values on the page — the fields
 * the resource's `_SORTS` map accepts. A `sort` naming anything else answers
 * `undefined`, which drops back to the resource's own default order.
 */
export function serverSortOnly(
  sort: string | undefined,
  sortKeys: readonly string[],
): string | undefined {
  if (sort === undefined) {
    return undefined
  }

  const bare = sort.startsWith('-') ? sort.slice(1) : sort

  return sortKeys.includes(bare) ? sort : undefined
}

/**
 * A value the sort knows how to compare. `null` (and `undefined`) always sort
 * to the bottom, regardless of direction — a missing value is not "less than"
 * or "greater than" anything, and pinning it to one end reads better than
 * scattering the blanks through the middle.
 */
export type SortValue = string | number | Date | boolean | readonly string[] | null | undefined

function typeRank(value: SortValue): number {
  if (value === null || value === undefined) {
    return 0
  }

  if (typeof value === 'string') {
    return value.length === 0 ? 0 : 1
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? 0 : 1
  }

  return 1
}

/** Returns a negative number if `a` sorts before `b`, positive if after, 0 for equal. */
export function compareValues(a: SortValue, b: SortValue): number {
  const rankA = typeRank(a)
  const rankB = typeRank(b)

  // Missing values sink to the bottom of the ascending order and stay there
  // when reversed. The direction reversal is the caller's job — a null being
  // "always last" is a property of the value, not of the direction.
  if (rankA === 0 && rankB === 0) {
    return 0
  }

  if (rankA === 0) {
    return 1
  }

  if (rankB === 0) {
    return -1
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime()
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? -1 : 1
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.join(', ').localeCompare(b.join(', '), undefined, { sensitivity: 'base', numeric: true })
  }

  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
}

/**
 * Stable sort by a caller-supplied accessor. `Array.prototype.sort` is not
 * guaranteed stable across every engine JS runs on, so ties fall back to the
 * original index — otherwise switching direction on a column with many ties
 * would reshuffle equal rows on every click.
 *
 * Missing values (null, undefined, empty string, empty array) pin to the
 * bottom in both directions. Reversing "asc null-last" as a signed compare
 * would put nulls on top under desc, which reads as broken — the direction
 * flip is applied only after the null pin is resolved.
 */
export function sortRowsBy<TRow>(
  rows: readonly TRow[],
  getValue: (row: TRow) => SortValue,
  direction: SortDirection,
): TRow[] {
  const indexed = rows.map((row, index) => ({ row, index, value: getValue(row) }))

  indexed.sort((left, right) => {
    const leftMissing = typeRank(left.value) === 0
    const rightMissing = typeRank(right.value) === 0

    if (leftMissing && rightMissing) {
      return left.index - right.index
    }

    if (leftMissing) {
      return 1
    }

    if (rightMissing) {
      return -1
    }

    const compared = compareValues(left.value, right.value)

    if (compared !== 0) {
      return direction === 'asc' ? compared : -compared
    }

    return left.index - right.index
  })

  return indexed.map((entry) => entry.row)
}

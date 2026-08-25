import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataTable } from './DataTable.tsx'
import type { Column } from './DataTable.tsx'

afterEach(cleanup)

interface Row {
  readonly id: string
  readonly name: string
  readonly score: number | null
}

const ROWS: readonly Row[] = [
  { id: '1', name: 'Charlie', score: 3 },
  { id: '2', name: 'Alpha', score: null },
  { id: '3', name: 'Bravo', score: 10 },
]

const COLUMNS: readonly Column<Row>[] = [
  {
    key: 'name',
    header: 'Name',
    sortKey: 'name',
    render: (row) => row.name,
  },
  {
    key: 'score',
    header: 'Score',
    getSortValue: (row) => row.score,
    render: (row) => (row.score === null ? '—' : String(row.score)),
  },
]

function names(): string[] {
  return Array.from(document.querySelectorAll('tbody tr td:first-child')).map(
    (cell) => cell.textContent ?? '',
  )
}

describe('DataTable sort dispatch', () => {
  it('routes a server-sortable column through onSortChange without reordering the rows itself', () => {
    // The server owns the order for `sortKey` columns — the table must not
    // pre-sort what came back, or the "Load more" cursor's keyset order and
    // what the eye sees would drift apart.
    const onSortChange = vi.fn()

    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort="name"
        onSortChange={onSortChange}
      />,
    )

    // Rows stay in the order the props gave them.
    expect(names()).toEqual(['Charlie', 'Alpha', 'Bravo'])

    fireEvent.click(screen.getByRole('button', { name: /Name/ }))

    expect(onSortChange).toHaveBeenCalledWith('-name')
  })

  it('sorts the rows in place when the active column is client-only', () => {
    const onSortChange = vi.fn()

    const { rerender } = render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort={undefined}
        onSortChange={onSortChange}
      />,
    )

    // No sort yet: rows sit in the props order.
    expect(names()).toEqual(['Charlie', 'Alpha', 'Bravo'])

    fireEvent.click(screen.getByRole('button', { name: /Score/ }))
    expect(onSortChange).toHaveBeenCalledWith('score')

    // The parent would normally hoist the sort into state — simulate that by
    // re-rendering with the string the header sent up.
    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort="score"
        onSortChange={onSortChange}
      />,
    )

    // Ascending: 3, 10, then the null row pinned last.
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha'])

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort="-score"
        onSortChange={onSortChange}
      />,
    )

    // Descending flips the compared values, but null stays last.
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha'])
  })

  it('shows the "sorted on this page" hint only for client-side sorts', () => {
    const { rerender } = render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort="name"
        onSortChange={() => undefined}
      />,
    )

    expect(screen.queryByText(/on this page/i)).toBeNull()

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        sort="score"
        onSortChange={() => undefined}
      />,
    )

    expect(screen.getByText(/on this page/i)).not.toBeNull()
  })
})

import type { ReactNode } from 'react'

import { sortRowsBy } from '../lib/sort.ts'
import type { SortValue } from '../lib/sort.ts'

export interface Column<TRow> {
  readonly key: string
  readonly header: string
  readonly className?: string | undefined
  readonly render: (row: TRow) => ReactNode
  /** The `?sort=` field this column drives. Omit for a column with no server-side sort. */
  readonly sortKey?: string | undefined
  /**
   * Returns the value this column sorts by on the client. Set on any column
   * whose resource cannot sort on it server-side (join columns, computed
   * values, fields not in the resource's `_SORTS` map). When the active sort
   * names a `Column.key` with this set, `DataTable` orders the loaded rows in
   * place and does not forward the change to the server.
   */
  readonly getSortValue?: ((row: TRow) => SortValue) | undefined
}

export interface DataTableGroup<TRow> {
  readonly id: string
  readonly label: ReactNode
  readonly rows: readonly TRow[]
}

export interface EmptyStateAction {
  readonly label: string
  readonly onClick: () => void
}

export interface DataTableProps<TRow> {
  readonly columns: readonly Column<TRow>[]
  readonly rows?: readonly TRow[] | undefined
  readonly groups?: readonly DataTableGroup<TRow>[] | undefined
  readonly onRowClick?: ((row: TRow) => void) | undefined
  readonly emptyMessage?: string | undefined
  /** Replaces the default "Add a record to get started." line under `emptyMessage`. */
  readonly emptyDescription?: string | undefined
  /** A button rendered in the empty state. Omit when there is nothing to do about it — a filter miss, not a genuinely empty list. */
  readonly emptyAction?: EmptyStateAction | undefined
  readonly getRowId: (row: TRow) => string
  /** Current `?sort=` value: `field` ascending, `-field` descending, `undefined` for the resource's default. */
  readonly sort?: string | undefined
  /** Fires with the next `?sort=` value when a sortable header is clicked. Required for any column to be clickable. */
  readonly onSortChange?: ((sort: string | undefined) => void) | undefined
  /**
   * Restricts rendering to these column keys, in the order the header uses.
   * Undefined shows every column. An unknown key is ignored rather than raising:
   * a stored preference outliving a rename should hide only what it recognises.
   */
  readonly visibleColumnKeys?: readonly string[] | undefined
}

type SortDirection = 'asc' | 'desc'

function directionOf(sort: string | undefined, field: string | undefined): SortDirection | undefined {
  if (field === undefined || sort === undefined) {
    return undefined
  }

  if (sort === field) {
    return 'asc'
  }

  return sort === `-${field}` ? 'desc' : undefined
}

/** Ascending, then descending, then back to the resource's own default. */
function nextSort(sort: string | undefined, field: string): string | undefined {
  const current = directionOf(sort, field)

  if (current === undefined) {
    return field
  }

  return current === 'asc' ? `-${field}` : undefined
}

/**
 * The identifier a column contributes to the sort string. Server sorts use the
 * `sortKey` — the field the server knows — so a stored sort keeps working when
 * a column is renamed in the UI. Client-only sorts fall back to the display
 * `key`, since there is no server field to reference.
 */
function sortFieldOf<TRow>(column: Column<TRow>): string | undefined {
  if (column.sortKey !== undefined) {
    return column.sortKey
  }

  return column.getSortValue !== undefined ? column.key : undefined
}

function findActiveClientColumn<TRow>(
  columns: readonly Column<TRow>[],
  sort: string | undefined,
): Column<TRow> | undefined {
  if (sort === undefined) {
    return undefined
  }

  const bare = sort.startsWith('-') ? sort.slice(1) : sort

  return columns.find(
    (column) => column.getSortValue !== undefined && column.sortKey === undefined && column.key === bare,
  )
}

export function DataTable<TRow>({
  columns,
  rows,
  groups,
  onRowClick,
  emptyMessage = 'No records yet',
  emptyDescription = 'Add a record to get started.',
  emptyAction,
  getRowId,
  sort,
  onSortChange,
  visibleColumnKeys,
}: DataTableProps<TRow>): React.JSX.Element {
  const flatRows = groups === undefined ? (rows ?? []) : groups.flatMap((group) => group.rows)
  const displayedColumns =
    visibleColumnKeys === undefined
      ? columns
      : columns.filter((column) => visibleColumnKeys.includes(column.key))

  // Client sort is a page-local reorder: the server-returned page order stays
  // the same, and only what is on screen shifts. Groups sort within each group,
  // because the group is the primary key of the view — mixing rows across
  // groups would break what the group header claims to count.
  const clientSortColumn = findActiveClientColumn(displayedColumns, sort)
  const clientDirection: SortDirection | undefined =
    clientSortColumn === undefined
      ? undefined
      : directionOf(sort, clientSortColumn.key) ?? undefined
  const displayedRows =
    clientSortColumn === undefined || clientDirection === undefined || rows === undefined
      ? rows
      : sortRowsBy(rows, clientSortColumn.getSortValue!, clientDirection)
  const displayedGroups =
    clientSortColumn === undefined || clientDirection === undefined || groups === undefined
      ? groups
      : groups.map((group) => ({
          ...group,
          rows: sortRowsBy(group.rows, clientSortColumn.getSortValue!, clientDirection),
        }))

  if (flatRows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-6 py-12 text-center">
        <p className="text-[13px] font-medium text-ink">{emptyMessage}</p>
        <p className="mt-1 text-[12px] text-ink-muted">{emptyDescription}</p>
        {emptyAction !== undefined && (
          <button
            type="button"
            onClick={emptyAction.onClick}
            className="mt-3 rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken"
          >
            {emptyAction.label}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {displayedColumns.map((column) => {
              const field = sortFieldOf(column)
              const direction = directionOf(sort, field)
              const sortable = field !== undefined && onSortChange !== undefined

              return (
                <th
                  key={column.key}
                  className={`px-3 py-2 text-[11px] font-medium text-ink-faint ${column.className ?? ''}`}
                >
                  {sortable && field !== undefined ? (
                    <button
                      type="button"
                      onClick={() => {
                        onSortChange?.(nextSort(sort, field))
                      }}
                      className="inline-flex items-center gap-1 transition hover:text-ink"
                    >
                      {column.header}
                      <span className="text-ink-faint">
                        {direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : ''}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {displayedGroups === undefined
            ? (displayedRows ?? []).map((row) => (
                <DataRow
                  key={getRowId(row)}
                  row={row}
                  columns={displayedColumns}
                  onRowClick={onRowClick}
                />
              ))
            : displayedGroups.map((group) => (
                <GroupRows
                  key={group.id}
                  group={group}
                  columns={displayedColumns}
                  onRowClick={onRowClick}
                  getRowId={getRowId}
                />
              ))}
        </tbody>
      </table>
      {clientSortColumn !== undefined && (
        <p className="border-t border-border bg-surface-sunken/40 px-3 py-1.5 text-[11px] text-ink-faint">
          Sorted by {clientSortColumn.header.toLowerCase()} on this page. Load more to sort the rest.
        </p>
      )}
    </div>
  )
}

function GroupRows<TRow>({
  group,
  columns,
  onRowClick,
  getRowId,
}: {
  readonly group: DataTableGroup<TRow>
  readonly columns: readonly Column<TRow>[]
  readonly onRowClick?: ((row: TRow) => void) | undefined
  readonly getRowId: (row: TRow) => string
}): React.JSX.Element {
  return (
    <>
      <tr className="border-b border-border bg-surface-sunken/60">
        <td colSpan={columns.length} className="px-3 py-1.5">
          <span className="inline-flex items-center gap-2">
            {group.label}
            <span className="font-mono text-[11px] text-ink-faint">{group.rows.length}</span>
          </span>
        </td>
      </tr>
      {group.rows.map((row) => (
        <DataRow key={getRowId(row)} row={row} columns={columns} onRowClick={onRowClick} />
      ))}
    </>
  )
}

function DataRow<TRow>({
  row,
  columns,
  onRowClick,
}: {
  readonly row: TRow
  readonly columns: readonly Column<TRow>[]
  readonly onRowClick?: ((row: TRow) => void) | undefined
}): React.JSX.Element {
  return (
    <tr
      onClick={() => onRowClick?.(row)}
      className={[
        'border-b border-border last:border-0 transition-colors',
        onRowClick === undefined ? '' : 'cursor-pointer hover:bg-surface-sunken/70',
      ].join(' ')}
    >
      {columns.map((column) => (
        <td key={column.key} className={`px-3 py-2 text-ink ${column.className ?? ''}`}>
          {column.render(row)}
        </td>
      ))}
    </tr>
  )
}

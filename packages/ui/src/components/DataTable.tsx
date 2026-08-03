import type { ReactNode } from 'react'

export interface Column<TRow> {
  readonly key: string
  readonly header: string
  readonly className?: string
  readonly render: (row: TRow) => ReactNode
}

export interface DataTableGroup<TRow> {
  readonly id: string
  readonly label: ReactNode
  readonly rows: readonly TRow[]
}

export interface DataTableProps<TRow> {
  readonly columns: readonly Column<TRow>[]
  readonly rows?: readonly TRow[]
  readonly groups?: readonly DataTableGroup<TRow>[]
  readonly onRowClick?: (row: TRow) => void
  readonly emptyMessage?: string
  readonly getRowId: (row: TRow) => string
}

export function DataTable<TRow>({
  columns,
  rows,
  groups,
  onRowClick,
  emptyMessage = 'No records yet',
  getRowId,
}: DataTableProps<TRow>): React.JSX.Element {
  const flatRows = groups === undefined ? (rows ?? []) : groups.flatMap((group) => group.rows)

  if (flatRows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-6 py-12 text-center">
        <p className="text-[13px] font-medium text-ink">{emptyMessage}</p>
        <p className="mt-1 text-[12px] text-ink-muted">Add a record to get started.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                className={`px-3 py-2 text-[11px] font-medium text-ink-faint ${column.className ?? ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups === undefined
            ? (rows ?? []).map((row) => (
                <DataRow
                  key={getRowId(row)}
                  row={row}
                  columns={columns}
                  onRowClick={onRowClick}
                />
              ))
            : groups.map((group) => (
                <GroupRows
                  key={group.id}
                  group={group}
                  columns={columns}
                  onRowClick={onRowClick}
                  getRowId={getRowId}
                />
              ))}
        </tbody>
      </table>
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
  readonly onRowClick?: (row: TRow) => void
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
  readonly onRowClick?: (row: TRow) => void
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

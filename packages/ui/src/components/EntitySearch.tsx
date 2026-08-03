import { useEffect, useId, useMemo, useRef, useState } from 'react'

/**
 * Pick a record, or create one by typing a name that does not match.
 *
 * One change from the mockups. There, `options` was the whole seed array and the
 * filtering happened here. Against the API a page cannot hold every company in
 * memory, so a parent may pass `onQueryChange` and answer with a `?q=` search
 * instead. When it does, local filtering is skipped: the server matches fields
 * this component never sees, and re-filtering the answer would hide real hits.
 */

export interface SearchOption {
  readonly id: string
  readonly label: string
  readonly meta?: string
}

export interface EntitySearchProps {
  readonly options: readonly SearchOption[]
  readonly value: string
  readonly onChange: (id: string) => void
  /** Set to run the search server-side. Receives what has been typed, trimmed of nothing. */
  readonly onQueryChange?: (query: string) => void
  /** When set, typing a name that is not an exact match offers a create row. */
  readonly onCreate?: (label: string) => void
  readonly createLabel?: (query: string) => string
  readonly placeholder?: string
  readonly emptyMessage?: string
  /** Most rows shown at once. The list says so when there are more. */
  readonly limit?: number
  readonly required?: boolean
  readonly className?: string
  readonly size?: 'sm' | 'md'
}

export function EntitySearch({
  options,
  value,
  onChange,
  onQueryChange,
  onCreate,
  createLabel = (query) => `Create “${query}”`,
  placeholder = 'Search…',
  emptyMessage = 'No matches',
  limit = 8,
  required,
  className = '',
  size = 'sm',
}: EntitySearchProps): React.JSX.Element {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.id === value)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()

    if (onQueryChange !== undefined || term.length === 0) {
      return options.slice(0, limit)
    }

    return options
      .filter(
        (option) =>
          option.label.toLowerCase().includes(term) ||
          (option.meta?.toLowerCase().includes(term) ?? false),
      )
      .slice(0, limit)
  }, [options, query, limit, onQueryChange])

  const trimmed = query.trim()
  const hasExactMatch = options.some(
    (option) => option.label.toLowerCase() === trimmed.toLowerCase(),
  )
  const showCreate = onCreate !== undefined && trimmed.length > 0 && !hasExactMatch
  const rowCount = filtered.length + (showCreate ? 1 : 0)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current?.contains(event.target as Node) !== true) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  function search(next: string): void {
    setQuery(next)
    onQueryChange?.(next)
  }

  function pick(id: string): void {
    onChange(id)
    setOpen(false)
    search('')
  }

  function create(): void {
    if (onCreate === undefined || trimmed.length === 0) {
      return
    }

    onCreate(trimmed)
    setOpen(false)
    search('')
  }

  const inputClass = size === 'sm' ? 'px-2 py-1.5 text-[12px]' : 'px-2.5 py-1.5 text-[13px]'

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input type="hidden" value={value} required={required} readOnly tabIndex={-1} aria-hidden />

      {selected !== undefined && !open ? (
        <div
          className={`flex items-center gap-1 rounded-md border border-border bg-surface-raised ${inputClass}`}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(true)
            }}
            className="min-w-0 flex-1 text-left"
          >
            <div className="truncate font-medium text-ink">{selected.label}</div>
            {selected.meta !== undefined && (
              <div className="truncate text-[11px] text-ink-faint">{selected.meta}</div>
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              onChange('')
              search('')
              setOpen(true)
            }}
            className="shrink-0 px-1 text-[12px] text-ink-faint hover:text-ink"
            aria-label="Clear"
          >
            ×
          </button>
        </div>
      ) : (
        <input
          value={query}
          onChange={(event) => {
            search(event.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
              setOpen(true)
              return
            }

            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlight((current) => Math.min(current + 1, Math.max(rowCount - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const hit = filtered[highlight]

              if (hit !== undefined) {
                pick(hit.id)
              } else if (showCreate) {
                create()
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
              search('')
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className={`w-full rounded-md border border-border bg-surface-raised outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 ${inputClass}`}
        />
      )}

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface-raised py-1"
        >
          {filtered.length === 0 && !showCreate ? (
            <li className="px-3 py-2 text-[12px] text-ink-faint">{emptyMessage}</li>
          ) : (
            <>
              {filtered.map((option, index) => (
                <li key={option.id} role="option" aria-selected={index === highlight}>
                  <button
                    type="button"
                    onMouseEnter={() => {
                      setHighlight(index)
                    }}
                    onClick={() => {
                      pick(option.id)
                    }}
                    className={[
                      'flex w-full flex-col px-3 py-1.5 text-left',
                      index === highlight ? 'bg-accent-soft' : 'hover:bg-surface',
                    ].join(' ')}
                  >
                    <span className="text-[12px] font-medium text-ink">{option.label}</span>
                    {option.meta !== undefined && (
                      <span className="text-[11px] text-ink-faint">{option.meta}</span>
                    )}
                  </button>
                </li>
              ))}
              {showCreate && (
                <li
                  role="option"
                  aria-selected={highlight === filtered.length}
                  className={filtered.length > 0 ? 'border-t border-border' : ''}
                >
                  <button
                    type="button"
                    onMouseEnter={() => {
                      setHighlight(filtered.length)
                    }}
                    onClick={create}
                    className={[
                      'flex w-full px-3 py-1.5 text-left text-[12px] font-medium text-accent',
                      highlight === filtered.length ? 'bg-accent-soft' : 'hover:bg-surface',
                    ].join(' ')}
                  >
                    {createLabel(trimmed)}
                  </button>
                </li>
              )}
            </>
          )}
          {options.length > limit && filtered.length === limit && (
            <li className="border-t border-border px-3 py-1.5 text-[10px] text-ink-faint">
              Showing top {limit} — keep typing to narrow
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

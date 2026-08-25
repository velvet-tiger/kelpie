import { useEffect, useRef, useState } from 'react'

/**
 * A "Columns" button that opens a popover of checkboxes for the columns a list
 * page can show.
 *
 * The picker owns nothing but the popover: the selection lives with the caller
 * (usually `useListView`) so the checked state cannot fall out of step with the
 * table beside it. `options` is the full set the page supports, in the display
 * order the header uses.
 *
 * The first column is pinned. A list with no columns at all is not a preference
 * anyone would make on purpose, and the primary column is what makes each row
 * identifiable — losing it turns every row into a set of anonymous fields.
 */
export interface ColumnPickerOption {
  readonly key: string
  readonly label: string
}

export interface ColumnPickerProps {
  readonly options: readonly ColumnPickerOption[]
  readonly visibleKeys: readonly string[]
  readonly onChange: (keys: readonly string[]) => void
}

export function ColumnPicker({ options, visibleKeys, onChange }: ColumnPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedKey = options[0]?.key

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) !== true) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function toggle(key: string, checked: boolean): void {
    if (key === pinnedKey) {
      return
    }

    // Preserve the order the caller passed in: the stored value is the visible
    // set, and re-adding a column should put it back where the table draws it,
    // not append it wherever the click landed.
    const next = options.map((option) => option.key).filter((candidate) => {
      if (candidate === key) {
        return checked
      }

      return visibleKeys.includes(candidate)
    })

    onChange(next)
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-ink transition hover:border-border-strong hover:bg-surface-sunken"
      >
        Columns
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1.5 max-h-80 w-56 overflow-y-auto rounded-md border border-border bg-surface-raised py-1"
        >
          {options.map((option) => {
            const checked = visibleKeys.includes(option.key)
            const pinned = option.key === pinnedKey

            return (
              <label
                key={option.key}
                className={[
                  'flex items-center gap-2 px-3 py-1.5 text-[13px] text-ink',
                  pinned ? 'cursor-default text-ink-muted' : 'cursor-pointer hover:bg-surface-sunken',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={pinned}
                  onChange={(event) => {
                    toggle(option.key, event.target.checked)
                  }}
                  className="h-3.5 w-3.5"
                />
                <span>{option.label}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

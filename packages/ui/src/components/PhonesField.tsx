import { useEffect, useRef, useState } from 'react'

export interface PhonesFieldProps {
  readonly value: readonly string[]
  readonly onChange: (phones: readonly string[]) => void
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/gu, '')}`
}

/** Add, edit, and remove phone numbers. Clearing one to empty removes it. */
export function PhonesField({ value, onChange }: PhonesFieldProps): React.JSX.Element {
  const addInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  useEffect(() => {
    if (adding) {
      addInputRef.current?.focus()
    }
  }, [adding])

  useEffect(() => {
    if (editingIndex !== null) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editingIndex])

  function cancelAdd(): void {
    setAdding(false)
    setDraft('')
  }

  function commitAdd(): void {
    const next = draft.trim()

    if (next.length === 0) {
      cancelAdd()
      return
    }

    onChange([...value, next])
    cancelAdd()
  }

  function cancelEdit(): void {
    setEditingIndex(null)
    setEditDraft('')
  }

  function commitEdit(): void {
    if (editingIndex === null) {
      return
    }

    const next = editDraft.trim()

    onChange(
      next.length === 0
        ? value.filter((_, index) => index !== editingIndex)
        : value.map((phone, index) => (index === editingIndex ? next : phone)),
    )
    cancelEdit()
  }

  function remove(index: number): void {
    if (editingIndex === index) {
      cancelEdit()
    }

    onChange(value.filter((_, position) => position !== index))
  }

  return (
    <div className="space-y-0.5">
      <ul>
        {value.map((phone, index) =>
          editingIndex === index ? (
            <li key={`editing-${String(index)}`} className="py-1">
              <input
                ref={editInputRef}
                type="tel"
                value={editDraft}
                onChange={(event) => {
                  setEditDraft(event.target.value)
                }}
                onBlur={commitEdit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitEdit()
                  }

                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  }
                }}
                className="w-full rounded-md border border-accent bg-surface-raised px-2 py-1 font-mono text-[12px] outline-none ring-2 ring-accent/20"
              />
            </li>
          ) : (
            <li
              key={`${phone}-${String(index)}`}
              className="-mx-1 flex items-center gap-1 rounded-md px-1 py-1 hover:bg-surface"
            >
              <a
                href={telHref(phone)}
                className="min-w-0 flex-1 truncate font-mono text-[12px] leading-snug text-ink hover:text-accent"
              >
                {phone}
              </a>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setEditingIndex(index)
                    setEditDraft(phone)
                  }}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-faint hover:bg-surface-raised hover:text-ink"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => {
                    remove(index)
                  }}
                  className="rounded px-1 py-0.5 text-[13px] leading-none text-ink-faint hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remove ${phone}`}
                >
                  ×
                </button>
              </div>
            </li>
          ),
        )}
      </ul>

      {value.length === 0 && !adding && <p className="py-0.5 text-[12px] text-ink-faint">None yet</p>}

      {adding ? (
        <div className="mt-1 space-y-1.5 rounded-md border border-border bg-surface px-2 py-2">
          <input
            ref={addInputRef}
            type="tel"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitAdd()
              }

              if (event.key === 'Escape') {
                event.preventDefault()
                cancelAdd()
              }
            }}
            placeholder="Phone number"
            className="w-full rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-[12px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={cancelAdd}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitAdd}
              disabled={draft.trim().length === 0}
              className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditingIndex(null)
            setAdding(true)
            setDraft('')
          }}
          className="mt-0.5 -mx-1 rounded-md px-1 py-1 text-[12px] font-medium text-ink-muted transition hover:bg-surface hover:text-accent"
        >
          + Add
        </button>
      )}
    </div>
  )
}

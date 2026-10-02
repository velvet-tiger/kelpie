import type { TagTargetType } from '@kelpie/schemas'
import { useEffect, useId, useRef, useState } from 'react'

import { useInvalidateTagSuggestions, useTagSuggestions } from '../api/resources/tags.ts'
import { Chip } from './Chip.tsx'

/**
 * Edit a record's tags: search the tags already in use, or create one.
 *
 * The search box holds only what is being typed. The chosen tags sit below it as
 * chips, each with an × to remove it, so the box can be empty while the record
 * still has tags. Every add and remove calls `onChange` at once with the whole
 * new list; the caller saves it.
 *
 * The list opens in the page flow, not over it, so it pushes the chips down
 * rather than hiding them. Chosen tags also lead the list, ticked, and a click
 * removes one.
 *
 * Suggestions come from `GET /v1/tags` for `targetType`, so a person's picker
 * offers person tags and not deal tags. A typed tag that differs from an
 * existing one only by case takes the existing spelling, so "Investor" does not
 * appear beside "investor".
 */

export interface TagInputProps {
  readonly value: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly targetType: TagTargetType
  readonly placeholder?: string | undefined
  /** `sm` for a record sidebar, `md` for a full-width form. */
  readonly size?: 'sm' | 'md' | undefined
  readonly label?: string | undefined
}

interface Row {
  readonly kind: 'chosen' | 'existing' | 'create'
  readonly tag: string
  readonly count: number | null
}

function sameTag(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

export function TagInput({
  value,
  onChange,
  targetType,
  placeholder = 'Search or create a tag…',
  size = 'sm',
  label = 'Tags',
}: TagInputProps): React.JSX.Element {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const { suggestions, isLoading } = useTagSuggestions(targetType, query, open)
  const invalidate = useInvalidateTagSuggestions()

  const trimmed = query.trim()
  // Chosen tags lead the list, ticked, so a reader can see what is already on
  // the record without closing it. They come from `value`, not the server, so
  // one outside the top suggestions still shows.
  const chosen = value.filter((tag) => tag.toLowerCase().includes(trimmed.toLowerCase()))
  const offered = suggestions.filter(
    (suggestion) => !value.some((tag) => sameTag(tag, suggestion.tag)),
  )
  const alreadyChosen = trimmed.length > 0 && value.some((tag) => sameTag(tag, trimmed))
  const exists = suggestions.some((suggestion) => sameTag(suggestion.tag, trimmed))
  const rows: readonly Row[] = [
    ...chosen.map((tag): Row => ({ kind: 'chosen', tag, count: null })),
    ...offered.map((suggestion): Row => ({
      kind: 'existing',
      tag: suggestion.tag,
      count: suggestion.count,
    })),
    ...(trimmed.length > 0 && !exists && !alreadyChosen
      ? [{ kind: 'create' as const, tag: trimmed, count: null }]
      : []),
  ]

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

  // Start on the first tag not yet chosen, so Enter adds rather than removes.
  // With nothing to add, nothing is highlighted, and Enter does nothing.
  const firstOffered = chosen.length < rows.length ? chosen.length : -1

  useEffect(() => {
    setHighlight(firstOffered)
  }, [query, open, firstOffered])

  /** Adds each tag not already chosen, in order, and clears the box. */
  function add(...tags: readonly string[]): void {
    const next = [...value]

    for (const tag of tags) {
      const clean = tag.trim()

      if (clean.length === 0 || next.some((existing) => sameTag(existing, clean))) {
        continue
      }

      // Take the spelling already in use, if there is one.
      const known = suggestions.find((suggestion) => sameTag(suggestion.tag, clean))

      next.push(known?.tag ?? clean)
    }

    setQuery('')

    if (next.length !== value.length) {
      onChange(next)
      invalidate()
    }
  }

  /**
   * A comma ends a tag, as it did when this was a text box. Handled on change
   * rather than on keydown, so a pasted "a, b, c" adds three tags too. What
   * follows the last comma stays in the box.
   */
  function type(text: string): void {
    const parts = text.split(',')
    const rest = parts.pop() ?? ''

    if (parts.length > 0) {
      add(...parts)
    }

    setQuery(rest)
    setOpen(true)
  }

  function remove(tag: string): void {
    onChange(value.filter((existing) => existing !== tag))
    invalidate()
  }

  const inputClass = size === 'sm' ? 'px-2 py-1.5 text-[12px]' : 'px-3 py-2 text-[13px]'

  return (
    <div ref={rootRef} className="space-y-1.5">
      <div className="relative">
        <input
          value={query}
          onChange={(event) => {
            type(event.target.value)
          }}
          onFocus={() => {
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setHighlight((current) => Math.min(current + 1, Math.max(rows.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const row = open ? rows[highlight] : undefined

              if (row?.kind === 'chosen') {
                remove(row.tag)
              } else {
                add(row?.tag ?? trimmed)
              }
            } else if (event.key === 'Escape') {
              setOpen(false)
              setQuery('')
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className={`w-full rounded-md border border-border bg-surface-raised outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 ${inputClass}`}
        />

        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} suggestions`}
            className="mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-surface-raised py-1"
          >
            {rows.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-ink-faint">
                {isLoading ? 'Loading…' : 'Type to create a tag'}
              </li>
            ) : (
              rows.map((row, index) => (
                <li
                  key={`${row.kind}:${row.tag}`}
                  role="option"
                  aria-selected={index === highlight}
                  aria-checked={row.kind === 'chosen'}
                  // A rule between the groups: chosen, then in use, then create.
                  className={
                    index > 0 && rows[index - 1]?.kind !== row.kind ? 'border-t border-border' : ''
                  }
                >
                  <button
                    type="button"
                    onMouseEnter={() => {
                      setHighlight(index)
                    }}
                    onClick={() => {
                      if (row.kind === 'chosen') {
                        remove(row.tag)
                      } else {
                        add(row.tag)
                      }
                    }}
                    className={[
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px]',
                      row.kind === 'create' ? 'font-medium text-accent' : 'text-ink',
                      index === highlight ? 'bg-accent-soft' : 'hover:bg-surface',
                    ].join(' ')}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {row.kind === 'chosen' && (
                        <span aria-hidden className="text-accent">
                          ✓
                        </span>
                      )}
                      <span className="truncate">
                        {row.kind === 'create' ? `Create “${row.tag}”` : row.tag}
                      </span>
                    </span>
                    {row.kind === 'chosen' && (
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        Added · click to remove
                      </span>
                    )}
                    {row.count !== null && row.count > 0 && (
                      <span className="shrink-0 text-[10px] text-ink-faint">{row.count}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {value.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-1">
          {value.map((tag) => (
            <li key={tag}>
              <Chip
                onRemove={() => {
                  remove(tag)
                }}
                removeLabel={`Remove tag ${tag}`}
              >
                {tag}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

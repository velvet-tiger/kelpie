import { formatRecordLinkToken, isRecordReferenceType } from '@kelpie/schemas'
import type { RecordReferenceType } from '@kelpie/schemas'
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { useSearch } from '../api/resources/search.ts'

/**
 * A textarea that links records: type `[[` and a few letters, pick a record, and
 * a `[[type:id|Label]]` token goes in where the brackets were.
 *
 * The choices come from `GET /v1/search`, the same public endpoint the search
 * page uses, so anything search finds can be linked. `@` is not a trigger. It is
 * kept for naming workspace members.
 */

/** How many choices the list shows. Search ranks them, so the best come first. */
const MAX_CHOICES = 8

const TYPE_LABELS: Readonly<Partial<Record<RecordReferenceType, string>>> = {
  handbook_page: 'Handbook',
  person: 'Person',
  role: 'Role',
  company: 'Company',
  enquiry: 'Enquiry',
  deal: 'Deal',
  opportunity: 'Opportunity',
  raise: 'Raise',
  partnership: 'Partnership',
  event: 'Event',
  decision: 'Decision',
  note: 'Note',
  plan_item: 'Plan item',
  list: 'List',
  form: 'Form',
}

interface Choice {
  readonly targetType: RecordReferenceType
  readonly targetId: string
  readonly title: string
  readonly subtitle: string | null
}

/** An open `[[`: where it starts, and what has been typed after it. */
interface Trigger {
  readonly start: number
  readonly query: string
}

/**
 * The `[[` the caret is in, if any. A `]` or a line break after the brackets
 * closes it, so finished tokens and ordinary brackets never reopen the list.
 */
function openTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret)
  const start = before.lastIndexOf('[[')

  if (start === -1) {
    return null
  }

  const query = before.slice(start + 2)

  return /[\]\n]/u.test(query) ? null : { start, query }
}

export interface RecordLinkTextareaProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly rows?: number
  readonly placeholder?: string
  readonly autoFocus?: boolean
  readonly className?: string
  readonly ariaLabel?: string
  readonly spellCheck?: boolean
}

export function RecordLinkTextarea({
  value,
  onChange,
  rows,
  placeholder,
  autoFocus,
  className,
  ariaLabel,
  spellCheck,
}: RecordLinkTextareaProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // The `[[` the user closed with Escape. It stays closed until they type
  // somewhere else, so Escape is not undone by the next keystroke.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)

  const trigger = openTrigger(value, caret)
  const open = trigger !== null && trigger.start !== dismissedAt
  const search = useSearch(open ? trigger.query : '')

  const choices: Choice[] = open
    ? (search.results?.groups ?? [])
        .flatMap((group): Choice[] => {
          const targetType = group.collection

          return isRecordReferenceType(targetType)
            ? group.items.map((item) => ({
                targetType,
                targetId: item.id,
                title: item.title,
                subtitle: item.subtitle,
              }))
            : []
        })
        .slice(0, MAX_CHOICES)
    : []

  // Put the caret after an inserted token once React has written the new value.
  useEffect(() => {
    if (pendingCaret !== null && textarea.current !== null) {
      textarea.current.setSelectionRange(pendingCaret, pendingCaret)
      setCaret(pendingCaret)
      setPendingCaret(null)
    }
  }, [pendingCaret, value])

  function readCaret(): void {
    const element = textarea.current

    if (element !== null) {
      setCaret(element.selectionStart)
    }
  }

  function choose(choice: Choice): void {
    if (trigger === null) {
      return
    }

    const token = formatRecordLinkToken({
      targetType: choice.targetType,
      targetId: choice.targetId,
      label: choice.title,
    })
    const next = value.slice(0, trigger.start) + token + value.slice(caret)

    onChange(next)
    setPendingCaret(trigger.start + token.length)
    setActive(0)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissedAt(trigger.start)

      return
    }

    if (choices.length === 0) {
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => (current + 1) % choices.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => (current - 1 + choices.length) % choices.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const choice = choices[Math.min(active, choices.length - 1)]

      if (choice !== undefined) {
        event.preventDefault()
        choose(choice)
      }
    }
  }

  const activeChoice = open && choices.length > 0 ? Math.min(active, choices.length - 1) : null

  return (
    <div className="relative">
      <textarea
        ref={textarea}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        onKeyUp={readCaret}
        onClick={readCaret}
        onSelect={readCaret}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={className}
        aria-label={ariaLabel}
        spellCheck={spellCheck}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeChoice === null ? undefined : `${listId}-${String(activeChoice)}`}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Link a record"
          className="absolute right-0 left-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-raised py-1 shadow-lg"
        >
          {trigger.query.trim().length === 0 ? (
            <p className="px-3 py-1.5 text-[12px] text-ink-faint">Type to find a record to link</p>
          ) : search.isLoading ? (
            <p className="px-3 py-1.5 text-[12px] text-ink-faint">Searching…</p>
          ) : choices.length === 0 ? (
            <p className="px-3 py-1.5 text-[12px] text-ink-faint">No records match</p>
          ) : (
            choices.map((choice, index) => (
              <div
                key={`${choice.targetType}:${choice.targetId}`}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={index === activeChoice}
                // mousedown, not click: a click would blur the textarea first.
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(choice)
                }}
                onMouseEnter={() => {
                  setActive(index)
                }}
                className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px] ${
                  index === activeChoice ? 'bg-surface-sunken' : ''
                }`}
              >
                <span className="truncate text-ink">{choice.title}</span>
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {TYPE_LABELS[choice.targetType] ?? choice.targetType}
                  {choice.subtitle === null ? '' : ` · ${choice.subtitle}`}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

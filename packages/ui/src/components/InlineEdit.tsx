import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

/**
 * Click a value, edit it in place, commit on blur or Enter, cancel on Escape.
 *
 * Ported unchanged in behaviour from the mockups. What changed is what `onChange`
 * does behind it: a page now hands it a mutation, and the optimistic update in
 * `createResourceHooks` is what keeps the committed value on screen while the
 * `PATCH` is in flight.
 */

interface CommonProps {
  readonly className?: string
  readonly displayClassName?: string
  readonly emptyLabel?: string
  /** Rendered instead of the raw value when not editing. */
  readonly display?: ReactNode
}

interface TextProps extends CommonProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly multiline?: boolean
  readonly type?: 'text' | 'number' | 'date' | 'datetime-local' | 'url' | 'email'
  /**
   * When the value is set, hover shows Visit (opens the address) and Edit
   * instead of making the whole value a click-to-edit control.
   */
  readonly visitable?: boolean
  readonly options?: never
}

interface SelectProps extends CommonProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly multiline?: never
  readonly type?: never
  readonly visitable?: never
}

export type InlineEditProps = TextProps | SelectProps

const ACTION_CLASS =
  'rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink'

function hrefForVisit(value: string): string {
  return /^https?:\/\//iu.test(value) ? value : `https://${value}`
}

export function InlineEdit(props: InlineEditProps): React.JSX.Element {
  const {
    value,
    onChange,
    className = '',
    displayClassName = '',
    emptyLabel = 'Add…',
    display,
  } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  useEffect(() => {
    if (!editing) {
      setDraft(value)
    }
  }, [value, editing])

  useEffect(() => {
    if (!editing) {
      return
    }

    const element = inputRef.current

    element?.focus()

    if (element !== null && props.options === undefined && 'select' in element) {
      element.select()
    }
  }, [editing, props.options])

  function commit(next = draft): void {
    onChange(next.trim())
    setEditing(false)
  }

  function cancel(): void {
    setDraft(value)
    setEditing(false)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }

    const commitsOnEnter =
      props.options === undefined &&
      (props.multiline !== true || event.metaKey || event.ctrlKey)

    if (event.key === 'Enter' && commitsOnEnter) {
      event.preventDefault()
      commit()
    }
  }

  if (editing && props.options !== undefined) {
    return (
      <select
        ref={inputRef as React.RefObject<HTMLSelectElement>}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          onChange(event.target.value)
          setEditing(false)
        }}
        onBlur={() => {
          setEditing(false)
        }}
        onKeyDown={onKeyDown}
        className={`w-full rounded-md border border-accent bg-surface-raised px-2 py-1 text-[13px] outline-none ring-2 ring-accent/20 ${className}`}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  if (editing && props.multiline === true) {
    return (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={() => {
          commit()
        }}
        onKeyDown={onKeyDown}
        rows={4}
        className={`w-full resize-y rounded-md border border-accent bg-surface-raised px-2 py-1.5 text-[13px] leading-relaxed outline-none ring-2 ring-accent/20 ${className}`}
      />
    )
  }

  if (editing) {
    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={props.type ?? 'text'}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={() => {
          commit()
        }}
        onKeyDown={onKeyDown}
        className={`w-full rounded-md border border-accent bg-surface-raised px-2 py-1 text-[13px] outline-none ring-2 ring-accent/20 ${className}`}
      />
    )
  }

  const isEmpty = value.length === 0 || value === '—'

  if (props.options === undefined && props.visitable === true && !isEmpty) {
    return (
      <div className={`group relative inline-flex max-w-full items-baseline ${className}`.trim()}>
        <span className={`text-[13px] leading-snug ${displayClassName}`.trim()}>{display ?? value}</span>
        <span className="absolute left-full top-1/2 flex -translate-y-1/2 gap-0.5 pl-1 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <a
            href={hrefForVisit(value)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${ACTION_CLASS} hover:text-accent`}
          >
            Visit
          </a>
          <button type="button" onClick={() => setEditing(true)} className={ACTION_CLASS}>
            Edit
          </button>
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setEditing(true)
      }}
      title="Click to edit"
      className={[
        'block w-full rounded-md px-1 py-0.5 text-left text-[13px] leading-snug transition',
        '-mx-1 hover:bg-accent-soft/50 hover:ring-1 hover:ring-border',
        isEmpty ? 'text-ink-faint italic' : '',
        displayClassName,
        className,
      ].join(' ')}
    >
      {isEmpty ? emptyLabel : (display ?? value)}
    </button>
  )
}

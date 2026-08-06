import { useEffect, useRef, useState } from 'react'

/**
 * Copies a value and says so for a moment.
 *
 * A failure is swallowed rather than reported: the clipboard is unavailable
 * outside a secure context, the value is on screen beside the button, and a
 * person who cannot copy can select it. Nothing is lost that an error message
 * would recover.
 */

const CONFIRMATION_MS = 1500

export interface CopyButtonProps {
  readonly value: string
  /** What is being copied, for the accessible name: "Copy endpoint". */
  readonly label: string
}

export function CopyButton({ value, label }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this, a copy immediately before navigation sets state on a component
  // that is no longer mounted.
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            timer.current = setTimeout(() => {
              setCopied(false)
            }, CONFIRMATION_MS)
          })
          .catch(() => undefined)
      }}
      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

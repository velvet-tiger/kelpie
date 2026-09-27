import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useLocation } from 'react-router'

/**
 * A row a link can point at: `/companies/com_1#note_1` opens the company and
 * brings note `note_1` into view.
 *
 * Notes, Decisions and Plan items have no page of their own, so a link to one
 * opens the record it is on with the item's id as the fragment. The row whose id
 * matches scrolls to the middle of the screen and is highlighted for a moment, so
 * the reader sees which one was meant. A row on a later page of its panel is not
 * on screen, and nothing happens.
 */

/** How long the highlight stays, in milliseconds. */
const HIGHLIGHT_MS = 2000

export interface FragmentTarget<T extends HTMLElement> {
  readonly ref: RefObject<T | null>
  readonly highlighted: boolean
}

export function useFragmentTarget<T extends HTMLElement>(id: string): FragmentTarget<T> {
  const { hash } = useLocation()
  const ref = useRef<T>(null)
  const [highlighted, setHighlighted] = useState(false)
  const targeted = hash === `#${id}`

  useEffect(() => {
    if (!targeted) {
      return undefined
    }

    const element = ref.current

    // jsdom has no layout, and so no `scrollIntoView`.
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    setHighlighted(true)

    const timer = window.setTimeout(() => {
      setHighlighted(false)
    }, HIGHLIGHT_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [targeted])

  return { ref, highlighted }
}

/** The classes a highlighted row adds. */
export const FRAGMENT_HIGHLIGHT = 'bg-accent-soft/40 ring-2 ring-accent/40'

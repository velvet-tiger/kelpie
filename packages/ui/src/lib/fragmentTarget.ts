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

/**
 * The detail-page tab that holds a row with this id prefix. Every record page
 * names these three tabs the same.
 */
const TAB_BY_PREFIX: readonly (readonly [string, string])[] = [
  ['note_', 'notes'],
  ['dec_', 'decisions'],
  ['plan_', 'plan'],
]

function tabForHash(hash: string): string | undefined {
  const id = hash.startsWith('#') ? hash.slice(1) : hash

  return TAB_BY_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1]
}

/**
 * A detail page's active tab, opened on the tab a fragment points into.
 *
 * `/companies/com_1#note_1` must land on Notes, or the row it names is not on
 * screen to scroll to. The fragment picks the tab on the first render and again
 * whenever it changes, so a link to another note on the same page switches too.
 * Anything else starts on Overview, and a click on a tab still wins.
 */
export function useRecordTab(): readonly [string, (tab: string) => void] {
  const { hash } = useLocation()
  const [tab, setTab] = useState(() => tabForHash(hash) ?? 'overview')

  useEffect(() => {
    const fromHash = tabForHash(hash)

    if (fromHash !== undefined) {
      setTab(fromHash)
    }
  }, [hash])

  return [tab, setTab]
}

/** The classes a highlighted row adds. */
export const FRAGMENT_HIGHLIGHT = 'bg-accent-soft/40 ring-2 ring-accent/40'

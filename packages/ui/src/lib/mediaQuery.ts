import { useSyncExternalStore } from 'react'

/** Tailwind's `md` breakpoint, as a query that matches below it. */
export const BELOW_MD_QUERY = '(max-width: 767.98px)'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/**
 * Whether `query` matches now, updated when it starts or stops matching. For
 * a layout that cannot be done with CSS alone, such as rendering a different
 * component tree. Without `matchMedia` (jsdom, server rendering) it is false.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange: () => void): (() => void) => {
      if (!hasMatchMedia()) {
        return () => undefined
      }

      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)

      return () => {
        list.removeEventListener('change', onChange)
      }
    },
    (): boolean => hasMatchMedia() && window.matchMedia(query).matches,
    (): boolean => false,
  )
}

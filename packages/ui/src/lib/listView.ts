import type { ListViewPreference } from '@kelpie/schemas'
import { useCallback, useMemo } from 'react'

import { useAccountPreferences, useUpdateAccountPreferences } from '../api/resources/account.ts'

/**
 * Which columns a list page shows the signed-in person.
 *
 * `defaultVisible` is the shape a person sees before they have ever customised
 * this view. `useListView` hides no column until preferences load — a request
 * that has not answered yet is not the same as "the person chose to hide
 * everything," and drawing an empty table under a spinner reads as broken.
 *
 * The set of column ids the page supports is the source of truth for what is
 * saveable. A stored id the page no longer recognises is ignored, and a page
 * column added since the last save falls back to `defaultVisible`.
 */
export interface ListViewController {
  readonly visibleKeys: readonly string[]
  readonly setVisibleKeys: (keys: readonly string[]) => void
  readonly isLoading: boolean
}

export function useListView(
  viewId: string,
  supportedKeys: readonly string[],
  defaultVisible: readonly string[],
): ListViewController {
  const { preferences, isLoading } = useAccountPreferences()
  const update = useUpdateAccountPreferences()

  const visibleKeys = useMemo(() => {
    const stored = preferences?.listViews[viewId]

    if (stored === undefined) {
      return defaultVisible
    }

    // A stored id the page no longer knows about is dropped, and if the filter
    // strips the whole list the default fills in — a page that lost every
    // recognised column to a rename should not render as empty.
    const kept = stored.columns.filter((key) => supportedKeys.includes(key))

    return kept.length === 0 ? defaultVisible : kept
  }, [preferences, viewId, supportedKeys, defaultVisible])

  const setVisibleKeys = useCallback(
    (keys: readonly string[]) => {
      const next: ListViewPreference = { columns: keys }
      const merged: Record<string, ListViewPreference> = {
        ...(preferences?.listViews ?? {}),
        [viewId]: next,
      }

      update.run({ listViews: merged })
    },
    [preferences, update, viewId],
  )

  return { visibleKeys, setVisibleKeys, isLoading }
}

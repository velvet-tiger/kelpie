import type { ListViewPreference } from '@kelpie/schemas'
import { useCallback, useMemo } from 'react'

import { useAccountPreferences, useUpdateAccountPreferences } from '../api/resources/account.ts'

/**
 * The saved view state a list or board page shows the signed-in person.
 *
 * `defaultVisible` is the columns a person sees before they have ever
 * customised this view. `useListView` hides no column until preferences load —
 * a request that has not answered yet is not the same as "the person chose to
 * hide everything," and drawing an empty table under a spinner reads as
 * broken.
 *
 * `mode`, `grouping`, `scope`, and `sort` mirror the four knobs a pipeline
 * page carries: the board-vs-list toggle, the list grouping, the pipeline
 * scope, and the current sort. Each returns `undefined` when the person has
 * not made a choice; the page decides its own default and passes it to the
 * relevant control. A setter called with `undefined` clears the stored
 * value, which is how a person returns a knob to "let the page decide".
 *
 * The set of column ids the page supports is the source of truth for what is
 * saveable. A stored id the page no longer recognises is ignored, and a page
 * column added since the last save falls back to `defaultVisible`.
 */
/**
 * A partial update to the stored preference. A key set to `undefined` removes
 * it, so a setter can return a knob to "use the page's default".
 */
interface ListViewPatch {
  readonly columns?: readonly string[] | undefined
  readonly mode?: 'list' | 'columns' | undefined
  readonly grouping?: string | undefined
  readonly scope?: string | undefined
  readonly sort?: string | undefined
}

export interface ListViewController {
  readonly visibleKeys: readonly string[]
  readonly setVisibleKeys: (keys: readonly string[]) => void
  readonly mode: 'list' | 'columns' | undefined
  readonly setMode: (mode: 'list' | 'columns' | undefined) => void
  readonly grouping: string | undefined
  readonly setGrouping: (grouping: string | undefined) => void
  readonly scope: string | undefined
  readonly setScope: (scope: string | undefined) => void
  readonly sort: string | undefined
  readonly setSort: (sort: string | undefined) => void
  readonly isLoading: boolean
}

export function useListView(
  viewId: string,
  supportedKeys: readonly string[],
  defaultVisible: readonly string[],
): ListViewController {
  const { preferences, isLoading } = useAccountPreferences()
  const update = useUpdateAccountPreferences()
  const stored = preferences?.listViews[viewId]

  const visibleKeys = useMemo(() => {
    const cols = stored?.columns

    if (cols === undefined) {
      return defaultVisible
    }

    // A stored id the page no longer knows about is dropped, and if the filter
    // strips the whole list the default fills in — a page that lost every
    // recognised column to a rename should not render as empty.
    const kept = cols.filter((key) => supportedKeys.includes(key))

    return kept.length === 0 ? defaultVisible : kept
  }, [stored, supportedKeys, defaultVisible])

  const patchView = useCallback(
    (patch: ListViewPatch): void => {
      // Merge into the existing entry so a change to one knob does not wipe
      // the other four. A key set to `undefined` in `patch` is removed from
      // the stored entry, so a setter can return a knob to "use the default".
      const merged: Record<string, unknown> = { ...(stored ?? {}) }

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }

      const nextViews: Record<string, ListViewPreference> = {
        ...(preferences?.listViews ?? {}),
        [viewId]: merged as ListViewPreference,
      }

      update.run({ listViews: nextViews })
    },
    [preferences, stored, update, viewId],
  )

  const setVisibleKeys = useCallback(
    (keys: readonly string[]) => {
      patchView({ columns: keys })
    },
    [patchView],
  )

  const setMode = useCallback(
    (mode: 'list' | 'columns' | undefined) => {
      patchView({ mode })
    },
    [patchView],
  )

  const setGrouping = useCallback(
    (grouping: string | undefined) => {
      patchView({ grouping })
    },
    [patchView],
  )

  const setScope = useCallback(
    (scope: string | undefined) => {
      patchView({ scope })
    },
    [patchView],
  )

  const setSort = useCallback(
    (sort: string | undefined) => {
      patchView({ sort })
    },
    [patchView],
  )

  return {
    visibleKeys,
    setVisibleKeys,
    mode: stored?.mode,
    setMode,
    grouping: stored?.grouping,
    setGrouping,
    scope: stored?.scope,
    setScope,
    sort: stored?.sort,
    setSort,
    isLoading,
  }
}

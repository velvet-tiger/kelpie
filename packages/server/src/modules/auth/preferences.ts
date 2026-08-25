import type { ListViewPreference, ThemePreference } from '@kelpie/schemas'

/**
 * What an account's preferences are before anyone has saved any, and how a
 * partial change becomes the whole row.
 *
 * `user_preferences` has no row until the first save. The alternative, seeding
 * one at signup, would leave every account created before this table was written
 * to without one, so the read path has to answer for a missing row regardless.
 * Given that, defaults live here rather than in the database, where a `PATCH`
 * would still have to know them to build an insert.
 */

export interface PreferenceValues {
  readonly timezone: string
  readonly theme: ThemePreference
  readonly emailDigest: boolean
  readonly mentionEmails: boolean
  readonly productUpdates: boolean
  readonly listViews: Readonly<Record<string, ListViewPreference>>
}

/**
 * UTC, not the workspace's zone. An account is global and may belong to several
 * workspaces in different zones, so deriving from one of them would be picking
 * arbitrarily and calling it the person's answer.
 *
 * `listViews` starts empty. Each list page falls back to its own default when
 * the map holds no entry for it, so the person sees the page's built-in shape
 * until they change it.
 */
export const DEFAULT_PREFERENCES: PreferenceValues = {
  timezone: 'UTC',
  theme: 'system',
  emailDigest: true,
  mentionEmails: true,
  productUpdates: false,
  listViews: {},
}

export type PreferenceChanges = Partial<PreferenceValues>

/**
 * Folds a `PATCH` body onto what is stored, or onto the defaults when nothing is.
 *
 * The result is always a complete row, which is what makes the write an upsert
 * with no read-modify-write hazard in the caller: the same request applied twice
 * produces the same row.
 *
 * `listViews` is treated as one field, so the caller replaces the whole map
 * rather than merging by key. The UI already holds the current map in the
 * account-preferences query, so a per-view change becomes a PATCH of the merged
 * map — the merge lives where the choice was made.
 */
export function applyPreferenceChanges(
  stored: PreferenceValues | undefined,
  changes: PreferenceChanges,
): PreferenceValues {
  const current = stored ?? DEFAULT_PREFERENCES

  return {
    timezone: changes.timezone ?? current.timezone,
    theme: changes.theme ?? current.theme,
    emailDigest: changes.emailDigest ?? current.emailDigest,
    mentionEmails: changes.mentionEmails ?? current.mentionEmails,
    productUpdates: changes.productUpdates ?? current.productUpdates,
    listViews: changes.listViews ?? current.listViews,
  }
}

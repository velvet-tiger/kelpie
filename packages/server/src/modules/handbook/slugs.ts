/**
 * Handbook slugs: the stable handle a page is addressed by.
 *
 * Hyphenated rather than the underscores a pipeline stage uses, because these are
 * the ones already written down. `onboarding.md` seeds `ideal-customer-profile`,
 * and `agent-tasks.md` names pages by exactly those strings in a task's
 * `handbookSlugs`.
 */

/** Long enough for a real page title, short enough to stay a handle. Matches the route's `slug` bound. */
export const MAX_SLUG_LENGTH = 100

/** What the API accepts as a hand-written slug: lowercase words joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * A slug derived from a page title: accents stripped, lowercased, runs of
 * anything else collapsed to one hyphen.
 *
 * @returns `page` for a title that leaves nothing behind, the way `Term sheet`
 *   leaves `term_sheet` but `!!!` leaves nothing at all.
 */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/gu, '')

  return slug.length === 0 ? 'page' : slug
}

/**
 * `pricing`, `pricing-2`, `pricing-3`: two pages may share a title, and the
 * unique index means they may not share a slug.
 *
 * @param taken Every slug already in the workspace.
 */
export function uniqueSlug(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) {
    return base
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - 1 - String(suffix).length)}-${String(suffix)}`

    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

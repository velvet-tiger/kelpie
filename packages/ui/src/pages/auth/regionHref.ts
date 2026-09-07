/**
 * The URL a region switcher navigates to: the other origin, plus the path,
 * query, and hash the reader is already on.
 */
export function regionHref(
  origin: string,
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  return `${origin}${location.pathname}${location.search}${location.hash}`
}

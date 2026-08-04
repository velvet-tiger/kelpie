/**
 * What an avatar shows when there is no picture.
 *
 * One implementation because the team list, the account menu, and the profile
 * page all draw the same circle for the same person, and three copies would
 * eventually disagree about it.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/u).slice(0, 2)
  const letters = parts.map((part) => part.slice(0, 1)).join('')

  return letters.length > 0 ? letters.toUpperCase() : '?'
}

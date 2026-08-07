/**
 * The day arithmetic behind the attention signals, with no I/O in it.
 *
 * Dates here are `YYYY-MM-DD` calendar days, the format `plan_items.date` and
 * `partnerships.next_touchpoint` are stored and returned in. They compare as
 * text because the format sorts lexicographically, so a window is a pair of
 * string bounds rather than a range of instants.
 *
 * `today` is always a parameter. A function that reads the clock cannot be
 * tested against a fixed expectation, and which day it is depends on the
 * workspace's zone anyway (`lib/timezones.ts`).
 */

/** How long since a contact before the relationship counts as going cold. */
export const STALE_CONTACT_DAYS = 14

/** How far ahead "due soon" looks, for plan items and partnership touchpoints. */
export const UPCOMING_DAYS = 7

/**
 * How many rows each embedded list carries when `?limit=` is absent.
 *
 * Smaller than the `?limit=` default every paged list uses, because this
 * response holds seven lists rather than one and the workspace home renders
 * four or five rows of each. The totals alongside them are exact regardless.
 */
export const DEFAULT_SIGNAL_LIMIT = 10

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Parsed at midday so no zone offset, and no daylight-saving jump, lands the
 * result on a neighbouring day.
 */
function atMidday(day: string): Date {
  return new Date(`${day}T12:00:00Z`)
}

/** @returns `day` moved by `days`, still `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  const moved = atMidday(day)

  moved.setUTCDate(moved.getUTCDate() + days)

  return moved.toISOString().slice(0, 10)
}

/** @returns Whole days from `from` to `to`, negative when `to` is the earlier of the two. */
export function daysBetween(from: string, to: string): number {
  return Math.round((atMidday(to).getTime() - atMidday(from).getTime()) / MILLISECONDS_PER_DAY)
}

/** The last day that still counts as "due soon" from `today`. */
export function upcomingEnd(today: string): string {
  return addDays(today, UPCOMING_DAYS)
}

/**
 * The first day a contact is still fresh on.
 *
 * A person contacted exactly `STALE_CONTACT_DAYS` ago is not yet stale: the
 * threshold is "more than a fortnight", and treating the boundary day as late
 * would flag somebody the day before the fortnight is up.
 */
export function staleContactCutoff(today: string): string {
  return addDays(today, -STALE_CONTACT_DAYS)
}

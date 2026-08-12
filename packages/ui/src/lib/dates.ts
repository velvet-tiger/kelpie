/**
 * How the app writes a moment. Ported from the mockup's own formatters so a
 * timeline reads the same as the one it was designed against.
 *
 * `now` is a parameter rather than a call to `new Date()` inside, because a
 * function that reads the clock cannot be tested against a fixed expectation.
 * `timezone` is a parameter for the same reason, and because two people in
 * different zones should see the day change at different moments. Resolve it
 * once with `resolveTimezone` and pass the result in.
 *
 * The locale is left undefined throughout, which asks `Intl` for the runtime's
 * own — the browser's, for every real caller. Formatters are built per call
 * rather than cached, matching `dayIn` on the server: the zone varies by
 * caller, and a cache keyed on it would only grow.
 */

/** The account's own choice, falling back to the workspace's, then to UTC. */
export function resolveTimezone(
  userTimezone: string | undefined,
  workspaceTimezone: string | undefined,
): string {
  return userTimezone ?? workspaceTimezone ?? 'UTC'
}

export function formatDateTime(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(value)
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`
}

/**
 * `3 days ago`.
 *
 * A future timestamp falls back to the absolute form. "in 3 days" on a history
 * panel means the clocks disagree, and phrasing it as elapsed time would hide
 * that.
 */
export function formatRelativeTime(value: Date, timezone: string, now: Date = new Date()): string {
  const elapsedMs = now.getTime() - value.getTime()

  if (elapsedMs < 0) {
    return formatDateTime(value, timezone)
  }

  const seconds = Math.round(elapsedMs / 1000)

  if (seconds < 60) {
    return 'just now'
  }

  const minutes = Math.round(seconds / 60)

  if (minutes < 60) {
    return plural(minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return plural(hours, 'hour')
  }

  const days = Math.round(hours / 24)

  if (days < 30) {
    return plural(days, 'day')
  }

  const months = Math.round(days / 30)

  return months < 12 ? plural(months, 'month') : plural(Math.round(months / 12), 'year')
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * A date-only field (`YYYY-MM-DD`), as the mockup writes one. Parsed at midday
 * so no timezone west or east of UTC shifts it onto a neighbouring day.
 *
 * Takes no `timezone`: the value is already a specific calendar day, usually
 * one the server resolved against the workspace's own zone, not an instant to
 * re-project into whoever is looking at it.
 */
export function formatDay(iso: string): string {
  return DAY.format(new Date(`${iso}T12:00:00`))
}

/** A moment whose time of day does not matter to the reader, e.g. when a decision was made. */
export function formatDate(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(value)
}

/** The year `value` falls in, within `timezone`, as digits — for comparison, not display. */
function yearIn(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', timeZone: timezone }).format(value)
}

/**
 * The heading a timeline groups under. The year is dropped for the current one.
 *
 * "Current" is judged in `timezone`, not the machine's own: a moment near a
 * year boundary is still December in one zone while already January somewhere
 * else, and the heading should agree with whichever zone it is rendered in.
 */
export function monthLabel(value: Date, timezone: string, now: Date = new Date()): string {
  return yearIn(value, timezone) === yearIn(now, timezone)
    ? new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: timezone }).format(value)
    : new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: timezone }).format(
        value,
      )
}

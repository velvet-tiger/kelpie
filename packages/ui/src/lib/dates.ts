/**
 * How the app writes a moment. Ported from the mockup's own formatters so a
 * timeline reads the same as the one it was designed against.
 *
 * `now` is a parameter rather than a call to `new Date()` inside, because a
 * function that reads the clock cannot be tested against a fixed expectation.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

export function formatDateTime(value: Date): string {
  return DATE_TIME.format(value)
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
export function formatRelativeTime(value: Date, now: Date = new Date()): string {
  const elapsedMs = now.getTime() - value.getTime()

  if (elapsedMs < 0) {
    return formatDateTime(value)
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

const DAY = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * A date-only field (`YYYY-MM-DD`), as the mockup writes one. Parsed at midday
 * so no timezone west or east of UTC shifts it onto a neighbouring day.
 */
export function formatDay(iso: string): string {
  return DAY.format(new Date(`${iso}T12:00:00`))
}

/** A moment whose time of day does not matter to the reader, e.g. when a decision was made. */
export function formatDate(value: Date): string {
  return DAY.format(value)
}

const MONTH = new Intl.DateTimeFormat('en-AU', { month: 'long' })
const MONTH_AND_YEAR = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' })

/** The heading a timeline groups under. The year is dropped for the current one. */
export function monthLabel(value: Date, now: Date = new Date()): string {
  return value.getFullYear() === now.getFullYear()
    ? MONTH.format(value)
    : MONTH_AND_YEAR.format(value)
}

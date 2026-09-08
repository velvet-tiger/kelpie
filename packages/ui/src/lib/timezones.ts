/**
 * IANA zone names this runtime can resolve, matching the server's
 * `timezoneSchema`. UTC is always first: some engines omit it from
 * `supportedValuesOf` even though `DateTimeFormat` accepts it.
 *
 * Falls back to the short list the mockup offered if `supportedValuesOf` is
 * missing, for a browser old enough to lack it.
 */

const FALLBACK_TIMEZONES: readonly string[] = [
  'UTC',
  'Australia/Sydney',
  'Australia/Melbourne',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
]

function readTimezones(): readonly string[] {
  try {
    const supported = Intl.supportedValuesOf('timeZone')

    return ['UTC', ...supported.filter((zone) => zone !== 'UTC')]
  } catch {
    return FALLBACK_TIMEZONES
  }
}

export const ALL_TIMEZONES: readonly string[] = readTimezones()

/**
 * The full list, with `current` prepended when a stored zone is not in it.
 *
 * A value the picker does not know must still render, rather than being
 * rewritten to the first option on the next save.
 */
export function timezonesIncluding(current: string): readonly string[] {
  if (current.length === 0 || ALL_TIMEZONES.includes(current)) {
    return ALL_TIMEZONES
  }

  return [current, ...ALL_TIMEZONES]
}

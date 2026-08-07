import { z } from 'zod'

/**
 * An IANA zone name, checked by asking `Intl` to build a formatter for it.
 *
 * A stored zone the platform cannot resolve would throw at render time, in a
 * component far from the request that accepted it, so the refusal belongs here.
 *
 * What `Intl` resolves is wider than the canonical list: it is case-insensitive
 * and takes legacy aliases, so `australia/sydney` and `Asia/Calcutta` both pass.
 * The value is stored as it was sent, so nothing downstream may assume a stored
 * zone is in canonical form. It is also whatever the running Node's ICU knows,
 * so a self-hosted deployment on a long-stale runtime could refuse a zone a
 * current browser resolved. Node 24 ships full ICU and knows every zone added
 * so far.
 *
 * This runs on write only, and there is no backfill. Every route that sets a
 * workspace zone has validated it since the first one shipped, so a stored zone
 * `dayIn` cannot resolve is corrupt data rather than a row that predates the
 * check. Refusing the next write hands the correction to whoever is editing it.
 */
export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })

      return true
    } catch {
      // Only a RangeError for an unknown zone reaches this. Intl throws nothing
      // else for a well-formed options object.
      return false
    }
  },
  { message: 'Must be an IANA time zone name, e.g. Australia/Sydney' },
)

/**
 * The calendar day it is in `timezone` at the instant `at`, as `YYYY-MM-DD`.
 *
 * Overdue is a question about days, not instants, and which day it is depends on
 * where the workspace is. Reading the server's own clock would put a Melbourne
 * workspace on yesterday's date for ten hours of every day.
 *
 * `en-CA` renders `YYYY-MM-DD` already, so the parts need no reassembling. The
 * formatter is built per call rather than cached, because the zone varies by
 * workspace and a cache keyed on it would outlive the request that needed it.
 *
 * @throws RangeError when the platform cannot resolve `timezone`. Every write
 *   path validates against `timezoneSchema`, so one that fails here is corrupt
 *   data; a 500 naming it is more use than silently answering in UTC.
 */
export function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

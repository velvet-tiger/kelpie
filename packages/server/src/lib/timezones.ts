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
 * This runs on write only. A row stored before the check survives until the
 * next write that carries the field, and there is no backfill: nothing formats
 * by a stored zone yet, so rewriting one to `UTC` would change what a workspace
 * means to prevent a failure that cannot happen. Refusing the next write hands
 * the correction to whoever is already editing it.
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

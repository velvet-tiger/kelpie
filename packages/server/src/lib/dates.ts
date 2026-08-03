import { z } from 'zod'

/**
 * The date-only wire format from `api.md`: `YYYY-MM-DD`.
 *
 * The shape check alone is not enough. `2026-02-30` matches the pattern, and
 * Postgres refuses it at insert time, which reaches the caller as a 500 for what
 * is a request error. Round-tripping the parsed date back to a string is what
 * rejects a day that does not exist, as a 422.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Use YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)

    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, 'That date does not exist')

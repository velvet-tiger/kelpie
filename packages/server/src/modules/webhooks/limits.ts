import { z } from 'zod'

/**
 * How much of the process one deployment lets webhooks use, and how much of
 * that one workspace may have.
 *
 * Delivery runs in the process that serves every workspace, and each delivery
 * holds a socket and its body in memory for up to the whole retry budget. With
 * no ceiling, one admin with many slow endpoints and a stream of events decides
 * how much of that process is left for everybody else. With a ceiling on the
 * process alone, the same admin decides whether anybody else's deliveries are
 * sent at all.
 */

/** What an unset `WEBHOOK_MAX_PER_WORKSPACE` means. */
export const DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE = 20

/** What an unset `WEBHOOK_MAX_CONCURRENT_DELIVERIES` means. */
export const DEFAULT_MAX_CONCURRENT_DELIVERIES = 20

/** What an unset `WEBHOOK_MAX_WAITING_DELIVERIES` means. */
export const DEFAULT_MAX_WAITING_DELIVERIES = 1_000

/** What an unset `WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE` means: a quarter of the process's slots. */
export const DEFAULT_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE = 5

/** What an unset `WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE` means: a quarter of the process's line. */
export const DEFAULT_MAX_WAITING_DELIVERIES_PER_WORKSPACE = 250

/**
 * One optional whole-number variable, read the way
 * `deliveryRetentionConfigSchema` reads its own: blank counts as absent, and
 * anything else that is not a whole number at or over the minimum stops boot.
 */
function wholeNumberSetting(fallback: number, minimum: number): z.ZodType<number> {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim().length === 0 ? undefined : value))
    .refine(
      (value) => value === undefined || (Number.isInteger(Number(value)) && Number(value) >= minimum),
      { message: `must be a whole number, at least ${String(minimum)}` },
    )
    .transform((value) => (value === undefined ? fallback : Number(value)))
}

/** Each workspace limit, and the process limit it is a share of. */
const SHARES = [
  ['WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE', 'WEBHOOK_MAX_CONCURRENT_DELIVERIES'],
  ['WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE', 'WEBHOOK_MAX_WAITING_DELIVERIES'],
] as const

/**
 * The environment slice for the limits. Validated at boot through
 * `context.config`, so a malformed value stops the service with the module
 * named, and never runs it with no limit or with the wrong one.
 *
 * A waiting limit of zero is allowed: it refuses a delivery whenever no slot
 * is free, which is a legitimate choice for a deployment that prefers a
 * failed delivery in the log to a late one.
 *
 * A workspace limit above its process limit is refused, a default included:
 * a deployment that lowers a process limit under the default share has to say
 * what the share is. The alternative is to lower the share without a word. A
 * workspace limit equal to its process limit is allowed. It lets one
 * workspace take everything, which is right for a deployment with one
 * workspace and for no other.
 */
export const webhookLimitsConfigSchema = z
  .object({
    WEBHOOK_MAX_PER_WORKSPACE: wholeNumberSetting(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE, 1),
    WEBHOOK_MAX_CONCURRENT_DELIVERIES: wholeNumberSetting(DEFAULT_MAX_CONCURRENT_DELIVERIES, 1),
    WEBHOOK_MAX_WAITING_DELIVERIES: wholeNumberSetting(DEFAULT_MAX_WAITING_DELIVERIES, 0),
    WEBHOOK_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE: wholeNumberSetting(
      DEFAULT_MAX_CONCURRENT_DELIVERIES_PER_WORKSPACE,
      1,
    ),
    WEBHOOK_MAX_WAITING_DELIVERIES_PER_WORKSPACE: wholeNumberSetting(
      DEFAULT_MAX_WAITING_DELIVERIES_PER_WORKSPACE,
      0,
    ),
  })
  .superRefine((limits, context) => {
    for (const [share, whole] of SHARES) {
      if (limits[share] > limits[whole]) {
        context.addIssue({
          code: 'custom',
          path: [share],
          message: `is ${String(limits[share])}, which is above ${whole} (${String(limits[whole])}). Set both, with the workspace limit at or under the process limit`,
        })
      }
    }
  })

export type WebhookLimitsConfig = z.infer<typeof webhookLimitsConfigSchema>

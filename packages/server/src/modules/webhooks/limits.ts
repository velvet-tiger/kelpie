import { z } from 'zod'

/**
 * How many webhooks one workspace may register.
 *
 * Each registration is an endpoint the process may have to call on every
 * event, and delivery runs in the process that serves every workspace. With
 * no ceiling, one admin decides how many requests each event of theirs costs
 * everybody.
 */

/** What an unset `WEBHOOK_MAX_PER_WORKSPACE` means. */
export const DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE = 20

/**
 * The environment slice for the limit, read the way
 * `deliveryRetentionConfigSchema` reads its own. Validated at boot through
 * `context.config`, so a malformed value stops the service with the module
 * named, and never runs it with no limit or with the wrong one.
 *
 * Blank counts as absent: operators empty a line far more often than they
 * delete it.
 */
export const webhookLimitsConfigSchema = z.object({
  WEBHOOK_MAX_PER_WORKSPACE: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim().length === 0 ? undefined : value))
    .refine(
      (value) => value === undefined || (Number.isInteger(Number(value)) && Number(value) >= 1),
      { message: 'must be a whole number, at least 1' },
    )
    .transform((value) =>
      value === undefined ? DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE : Number(value),
    ),
})

export type WebhookLimitsConfig = z.infer<typeof webhookLimitsConfigSchema>

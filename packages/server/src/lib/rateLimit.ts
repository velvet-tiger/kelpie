import { z } from 'zod'

/**
 * Budgets for the request classes `api.md` rate-limits: public form submissions,
 * unauthenticated auth endpoints by IP, login by account, and everything else
 * under an API key. Roadmap Phase 6: self-host packaging calls for this with
 * nothing to configure, so every variable here is optional and defaulted.
 */

export interface RateLimitBudget {
  readonly limit: number
  readonly windowMs: number
}

export interface RateLimitConfig {
  readonly forms: RateLimitBudget
  readonly auth: RateLimitBudget
  /**
   * Login attempts for one email address, whatever IP they come from. The `auth`
   * budget alone caps one IP, so a botnet spread across many addresses could
   * still grind one account. This is the per-account half of that defence.
   */
  readonly loginAccount: RateLimitBudget
  readonly api: RateLimitBudget
}

export const rateLimitConfigSchema = z.object({
  RATE_LIMIT_FORMS_LIMIT: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_FORMS_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AUTH_LIMIT: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LOGIN_ACCOUNT_LIMIT: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_API_LIMIT: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_API_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
})

export function rateLimitConfigFrom(parsed: z.infer<typeof rateLimitConfigSchema>): RateLimitConfig {
  return {
    forms: {
      limit: parsed.RATE_LIMIT_FORMS_LIMIT,
      windowMs: parsed.RATE_LIMIT_FORMS_WINDOW_SECONDS * 1000,
    },
    auth: {
      limit: parsed.RATE_LIMIT_AUTH_LIMIT,
      windowMs: parsed.RATE_LIMIT_AUTH_WINDOW_SECONDS * 1000,
    },
    loginAccount: {
      limit: parsed.RATE_LIMIT_LOGIN_ACCOUNT_LIMIT,
      windowMs: parsed.RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS * 1000,
    },
    api: {
      limit: parsed.RATE_LIMIT_API_LIMIT,
      windowMs: parsed.RATE_LIMIT_API_WINDOW_SECONDS * 1000,
    },
  }
}

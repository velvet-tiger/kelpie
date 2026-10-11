import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE, webhookLimitsConfigSchema } from './limits.ts'

describe('webhookLimitsConfigSchema', () => {
  function limitFrom(environment: Record<string, string>): number {
    return webhookLimitsConfigSchema.parse(environment).WEBHOOK_MAX_PER_WORKSPACE
  }

  it('defaults to 20 when the variable is unset, and when it is blank', () => {
    expect(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE).toBe(20)
    expect(limitFrom({})).toBe(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE)
    // Blank counts as absent: operators empty a line rather than delete it.
    expect(limitFrom({ WEBHOOK_MAX_PER_WORKSPACE: '  ' })).toBe(DEFAULT_MAX_WEBHOOKS_PER_WORKSPACE)
  })

  it('reads a whole number', () => {
    expect(limitFrom({ WEBHOOK_MAX_PER_WORKSPACE: '1' })).toBe(1)
    expect(limitFrom({ WEBHOOK_MAX_PER_WORKSPACE: '500' })).toBe(500)
  })

  /** A malformed value stops boot rather than running with no limit. */
  it('refuses zero, negatives, fractions and words', () => {
    for (const value of ['0', '-1', '2.5', 'many', 'NaN', 'Infinity']) {
      expect(webhookLimitsConfigSchema.safeParse({ WEBHOOK_MAX_PER_WORKSPACE: value }).success).toBe(false)
    }
  })
})

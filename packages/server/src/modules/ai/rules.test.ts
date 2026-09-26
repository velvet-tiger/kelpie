import { describe, expect, it } from 'vitest'

import {
  keyHint,
  monthWindowStart,
  resolveAiCredentials,
  staleBefore,
} from './rules.ts'

/**
 * Pure rules for the AI module. Runs without a database, so it lives beside the
 * module rather than under `test/`.
 */

describe('monthWindowStart', () => {
  it('returns the first instant of the UTC month', () => {
    expect(monthWindowStart(new Date('2026-08-15T13:24:00Z'))).toEqual(
      new Date('2026-08-01T00:00:00Z'),
    )
  })

  it('handles year boundaries', () => {
    expect(monthWindowStart(new Date('2027-01-01T00:00:00Z'))).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    )
    expect(monthWindowStart(new Date('2026-12-31T23:59:59Z'))).toEqual(
      new Date('2026-12-01T00:00:00Z'),
    )
  })
})

describe('staleBefore', () => {
  it('subtracts the timeout window from now', () => {
    const now = new Date('2026-08-15T12:00:00Z')

    expect(staleBefore(now, 15)).toEqual(new Date('2026-08-15T11:45:00Z'))
  })
})

describe('resolveAiCredentials', () => {
  const none = { provider: undefined, apiKey: undefined, model: undefined }
  const openaiEnvironment = { provider: 'openai' as const, apiKey: 'sk-env', model: 'gpt-5' }

  it('has nothing to offer with no provider anywhere', () => {
    expect(resolveAiCredentials(none, undefined)).toEqual({ provider: null, model: '', apiKey: null, keySource: null })
  })

  it('uses the environment alone in deployment mode', () => {
    expect(resolveAiCredentials(openaiEnvironment, undefined)).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-env',
      keySource: 'environment',
    })
  })

  it('prefers the workspace key and model, field by field', () => {
    expect(
      resolveAiCredentials(openaiEnvironment, { provider: 'openai', model: null, apiKey: 'sk-own' }),
    ).toEqual({ provider: 'openai', model: 'gpt-5', apiKey: 'sk-own', keySource: 'workspace' })
  })

  it('falls back to the environment key when the workspace has none', () => {
    expect(
      resolveAiCredentials(openaiEnvironment, { provider: null, model: 'gpt-5-nano', apiKey: null }),
    ).toEqual({ provider: 'openai', model: 'gpt-5-nano', apiKey: 'sk-env', keySource: 'environment' })
  })

  it('never lends the environment key or model to another provider', () => {
    expect(
      resolveAiCredentials(openaiEnvironment, { provider: 'anthropic', model: null, apiKey: null }),
    ).toEqual({ provider: 'anthropic', model: 'claude-opus-5', apiKey: null, keySource: null })
  })
})

describe('keyHint', () => {
  it('shows the last four characters of a real key', () => {
    expect(keyHint('sk-ant-api03-abcdWXYZ')).toBe('WXYZ')
  })

  it('shows nothing for no key or a key too short to hint at safely', () => {
    expect(keyHint(null)).toBeNull()
    expect(keyHint('short-key')).toBeNull()
  })
})

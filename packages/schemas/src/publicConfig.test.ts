import { describe, expect, it } from 'vitest'

import { isHttpOrigin, publicConfigSchema } from './publicConfig.ts'

describe('isHttpOrigin', () => {
  it('accepts an absolute http or https origin', () => {
    expect(isHttpOrigin('https://us.kelpie.example')).toBe(true)
    expect(isHttpOrigin('http://localhost:3000')).toBe(true)
  })

  it('rejects a host without a scheme, a path, or a query', () => {
    expect(isHttpOrigin('us.kelpie.example')).toBe(false)
    expect(isHttpOrigin('https://us.kelpie.example/login')).toBe(false)
    expect(isHttpOrigin('https://us.kelpie.example?next=/')).toBe(false)
    expect(isHttpOrigin('ftp://us.kelpie.example')).toBe(false)
  })
})

describe('publicConfigSchema', () => {
  it('defaults a missing regions list to empty', () => {
    expect(
      publicConfigSchema.parse({
        runtime_mode: 'production',
        site_name: null,
        signups_enabled: true,
      }),
    ).toEqual({
      runtimeMode: 'production',
      siteName: null,
      signupsEnabled: true,
      regions: [],
    })
  })

  it('reads a configured list', () => {
    const regions = [
      { id: 'us', label: 'United States', origin: 'https://us.kelpie.example' },
      { id: 'uk', label: 'United Kingdom', origin: 'https://uk.kelpie.example' },
    ]

    expect(
      publicConfigSchema.parse({
        runtime_mode: 'production',
        site_name: null,
        signups_enabled: true,
        regions,
      }),
    ).toMatchObject({ regions })
  })

  it('rejects an origin that is not an absolute http origin', () => {
    expect(() =>
      publicConfigSchema.parse({
        runtime_mode: 'production',
        site_name: null,
        signups_enabled: true,
        regions: [{ id: 'us', label: 'United States', origin: 'us.kelpie.example' }],
      }),
    ).toThrow()
  })
})

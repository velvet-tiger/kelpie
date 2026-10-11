import { describe, expect, it } from 'vitest'

import { safeNext } from './nextPath.ts'

describe('safeNext', () => {
  it('keeps a path within this app', () => {
    expect(safeNext('/people')).toBe('/people')
    expect(safeNext('/')).toBe('/')
    expect(safeNext('/deals/deal_123')).toBe('/deals/deal_123')
  })

  it('keeps the query and the hash of a path', () => {
    expect(safeNext('/people?sort=-created_at&q=ada%20lovelace')).toBe('/people?sort=-created_at&q=ada%20lovelace')
    expect(safeNext('/handbook/voice#tone')).toBe('/handbook/voice#tone')
    expect(safeNext('/consent/req_1?from=https://client.example/callback#top')).toBe(
      '/consent/req_1?from=https://client.example/callback#top',
    )
  })

  it('sends a missing or empty value to the dashboard', () => {
    expect(safeNext(null)).toBe('/dashboard')
    expect(safeNext('')).toBe('/dashboard')
  })

  it('refuses an absolute URL', () => {
    expect(safeNext('https://evil.example/')).toBe('/dashboard')
    expect(safeNext('javascript:alert(1)')).toBe('/dashboard')
    expect(safeNext('people')).toBe('/dashboard')
  })

  it('refuses a URL with no scheme, which names another site', () => {
    expect(safeNext('//evil.example')).toBe('/dashboard')
    expect(safeNext('//evil.example/people')).toBe('/dashboard')
  })

  it('refuses a backslash, which a browser reads as a slash', () => {
    expect(safeNext('/\\evil.example')).toBe('/dashboard')
    expect(safeNext('/\\/evil.example')).toBe('/dashboard')
    expect(safeNext('\\/evil.example')).toBe('/dashboard')
    expect(safeNext('/people\\..\\admin')).toBe('/dashboard')
  })

  it('refuses a control character, which a browser removes from a URL', () => {
    expect(safeNext('/\t/evil.example')).toBe('/dashboard')
    expect(safeNext('/\n/evil.example')).toBe('/dashboard')
    expect(safeNext('/\r/evil.example')).toBe('/dashboard')
    expect(safeNext('/\t\\evil.example')).toBe('/dashboard')
    expect(safeNext('/people\u0000')).toBe('/dashboard')
    expect(safeNext('/people\u001f')).toBe('/dashboard')
    expect(safeNext('/people\u007f')).toBe('/dashboard')
    expect(safeNext('/people\u0085')).toBe('/dashboard')
  })
})

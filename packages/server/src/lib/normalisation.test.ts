import { describe, expect, it } from 'vitest'

import { normaliseDomain, normaliseEmail } from './normalisation.ts'

describe('normaliseEmail', () => {
  it('trims and lowercases', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })

  it('treats blank as absent', () => {
    expect(normaliseEmail('')).toBeNull()
    expect(normaliseEmail('   ')).toBeNull()
  })
})

describe('normaliseDomain', () => {
  it('reduces whatever was pasted to a host', () => {
    expect(normaliseDomain('https://Analytical.example/about?ref=x')).toBe('analytical.example')
    expect(normaliseDomain('http://analytical.example')).toBe('analytical.example')
    expect(normaliseDomain('  Analytical.example  ')).toBe('analytical.example')
    expect(normaliseDomain('analytical.example.')).toBe('analytical.example')
  })

  it('leaves a subdomain alone, because it is part of the host', () => {
    expect(normaliseDomain('https://www.analytical.example')).toBe('www.analytical.example')
  })

  it('treats blank as absent', () => {
    expect(normaliseDomain('')).toBeNull()
    expect(normaliseDomain('   ')).toBeNull()
    expect(normaliseDomain('https://')).toBeNull()
  })
})

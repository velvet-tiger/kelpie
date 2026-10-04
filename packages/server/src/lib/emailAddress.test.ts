import { describe, expect, it } from 'vitest'

import { isSingleEmailAddress } from './emailAddress.ts'

describe('isSingleEmailAddress', () => {
  it('accepts one ordinary address', () => {
    expect(isSingleEmailAddress('ada@example.com')).toBe(true)
    expect(isSingleEmailAddress('ada.lovelace+crm@mail.example.co.uk')).toBe(true)
    expect(isSingleEmailAddress("o'brien@example.com")).toBe(true)
  })

  it('accepts an internationalised address', () => {
    expect(isSingleEmailAddress('josé@example.com')).toBe(true)
    expect(isSingleEmailAddress('ada@münchen.example')).toBe(true)
  })

  it('refuses a list of addresses', () => {
    expect(isSingleEmailAddress('a@x.com, b@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com,b@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com;b@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com b@y.com')).toBe(false)
    expect(isSingleEmailAddress('team: a@x.com')).toBe(false)
  })

  it('refuses the display-name form', () => {
    expect(isSingleEmailAddress('Name <a@x.com>')).toBe(false)
    expect(isSingleEmailAddress('<a@x.com>')).toBe(false)
    expect(isSingleEmailAddress('"a@x.com"@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com(note)')).toBe(false)
  })

  it('refuses markup', () => {
    expect(isSingleEmailAddress('<script>alert(1)</script>@x.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com<script>')).toBe(false)
    expect(isSingleEmailAddress('<a href="https://evil.example">a@x.com</a>')).toBe(false)
  })

  it('refuses a line break, which would start a new header', () => {
    expect(isSingleEmailAddress('a@x.com\nBcc: b@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com\r\nBcc:b@y.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com\n')).toBe(false)
  })

  it('refuses spaces, control characters and invisible characters', () => {
    expect(isSingleEmailAddress(' a@x.com')).toBe(false)
    expect(isSingleEmailAddress('a@x.com\t')).toBe(false)
    expect(isSingleEmailAddress('a\u0000@x.com')).toBe(false)
    expect(isSingleEmailAddress('a b@x.com')).toBe(false)
    expect(isSingleEmailAddress('a​@x.com')).toBe(false)
    expect(isSingleEmailAddress('a‮@x.com')).toBe(false)
  })

  it('refuses text that is not shaped like an address', () => {
    expect(isSingleEmailAddress('')).toBe(false)
    expect(isSingleEmailAddress('ada')).toBe(false)
    expect(isSingleEmailAddress('@example.com')).toBe(false)
    expect(isSingleEmailAddress('ada@')).toBe(false)
    expect(isSingleEmailAddress('ada@example')).toBe(false)
    expect(isSingleEmailAddress('ada@.example.com')).toBe(false)
    expect(isSingleEmailAddress('ada@example.com.')).toBe(false)
    expect(isSingleEmailAddress('ada@example..com')).toBe(false)
    expect(isSingleEmailAddress('a@b@example.com')).toBe(false)
  })

  it('holds the length limits', () => {
    const local = 'a'.repeat(64)

    expect(isSingleEmailAddress(`${local}@example.com`)).toBe(true)
    expect(isSingleEmailAddress(`${local}a@example.com`)).toBe(false)

    // 64 + 1 + 189 = 254 characters, the longest address that passes.
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`

    expect(`${local}@${domain}`).toHaveLength(254)
    expect(isSingleEmailAddress(`${local}@${domain}`)).toBe(true)
    expect(isSingleEmailAddress(`${local}@d${domain}`)).toBe(false)
  })
})

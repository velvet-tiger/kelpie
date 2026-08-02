import { describe, expect, it } from 'vitest'

import { createIdFactory, idPrefixes } from './ids.ts'

describe('createIdFactory', () => {
  it('prefixes the generated ulid with the object prefix', () => {
    const createId = createIdFactory(() => '01J8ZQ3R9V6X')

    expect(createId('person')).toBe('per_01J8ZQ3R9V6X')
    expect(createId('company')).toBe('com_01J8ZQ3R9V6X')
    expect(createId('handbookPage')).toBe('hb_01J8ZQ3R9V6X')
  })

  it('produces distinct ids from the default generator', () => {
    const createId = createIdFactory()

    expect(createId('deal')).not.toBe(createId('deal'))
  })

  it('keeps every prefix distinct', () => {
    const prefixes = Object.values(idPrefixes)

    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})

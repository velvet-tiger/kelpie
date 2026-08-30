import { describe, expect, it } from 'vitest'

import { composeName } from './names.ts'

describe('composeName', () => {
  it('joins a first and last name', () => {
    expect(composeName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace')
  })

  it('keeps a suffix, which is part of the name', () => {
    expect(composeName({ firstName: 'Sammy', lastName: 'Davis', suffix: 'Jr' })).toBe(
      'Sammy Davis Jr',
    )
  })

  it('composes a one-part name rather than padding the gap', () => {
    expect(composeName({ firstName: 'Prince' })).toBe('Prince')
    expect(composeName({ lastName: 'Lovelace' })).toBe('Lovelace')
  })

  it('treats null, undefined, and whitespace alike as nothing to contribute', () => {
    expect(composeName({ firstName: 'Ada', lastName: null })).toBe('Ada')
    expect(composeName({ firstName: 'Ada', lastName: undefined })).toBe('Ada')
    expect(composeName({ firstName: '  Ada  ', lastName: '   ' })).toBe('Ada')
  })

  it('is empty when no part carried anything, which is the caller’s signal to look elsewhere', () => {
    expect(composeName({})).toBe('')
    expect(composeName({ firstName: null, lastName: '  ' })).toBe('')
  })
})

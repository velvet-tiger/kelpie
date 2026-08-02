import { describe, expect, it } from 'vitest'

import { changedKeys } from './changes.ts'

describe('changedKeys', () => {
  it('ignores a field resent with the value it already had', () => {
    expect(changedKeys({ name: 'Ada', summary: 'Same' }, { summary: 'Same' })).toEqual([])
  })

  it('reports only the fields that moved', () => {
    const changed = changedKeys(
      { name: 'Ada', summary: 'Original' },
      { name: 'Ada', summary: 'Rewritten' },
    )

    expect(changed).toEqual(['summary'])
  })

  it('ignores an absent field, because PATCH leaves it alone', () => {
    expect(changedKeys({ name: 'Ada' }, { name: undefined })).toEqual([])
  })

  it('sees through arrays and objects rather than comparing references', () => {
    expect(changedKeys({ tags: ['one', 'two'] }, { tags: ['one', 'two'] })).toEqual([])
    expect(changedKeys({ tags: ['one'] }, { tags: ['two'] })).toEqual(['tags'])
    expect(changedKeys({ phones: [{ number: '1' }] }, { phones: [{ number: '1' }] })).toEqual([])
  })

  it('compares dates by instant', () => {
    const when = '2026-08-02T01:00:00.000Z'

    expect(changedKeys({ seenAt: new Date(when) }, { seenAt: new Date(when) })).toEqual([])
    expect(changedKeys({ seenAt: new Date(when) }, { seenAt: null })).toEqual(['seenAt'])
    expect(changedKeys({ seenAt: null }, { seenAt: new Date(when) })).toEqual(['seenAt'])
  })

  it('counts clearing an already-empty field as no change', () => {
    expect(changedKeys({ email: null }, { email: null })).toEqual([])
  })
})

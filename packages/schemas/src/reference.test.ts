import { describe, expect, it } from 'vitest'

import { formatRecordLinkToken, recordReferenceSchema, splitRecordLinkTokens } from './reference.ts'

function tokensIn(text: string): unknown[] {
  return splitRecordLinkTokens(text).flatMap((segment) => (segment.kind === 'token' ? [segment.token] : []))
}

describe('splitRecordLinkTokens', () => {
  it('splits prose around a token', () => {
    expect(splitRecordLinkTokens('Met [[company:com_01|Acme]] today')).toEqual([
      { kind: 'text', text: 'Met ' },
      { kind: 'token', token: { targetType: 'company', targetId: 'com_01', label: 'Acme' } },
      { kind: 'text', text: ' today' },
    ])
  })

  it('reads a token with no label, and treats a blank label as none', () => {
    expect(tokensIn('[[person:per_01]] [[deal:deal_01|  ]]')).toEqual([
      { targetType: 'person', targetId: 'per_01', label: null },
      { targetType: 'deal', targetId: 'deal_01', label: null },
    ])
  })

  it('reads the two types that are not record targets', () => {
    expect(tokensIn('[[handbook_page:hb_01|Voice]] [[role:role_01|Engineer]]')).toEqual([
      { targetType: 'handbook_page', targetId: 'hb_01', label: 'Voice' },
      { targetType: 'role', targetId: 'role_01', label: 'Engineer' },
    ])
  })

  it('leaves a token with an unknown type as text', () => {
    expect(splitRecordLinkTokens('a [[webhook:wh_01|X]] b')).toEqual([
      { kind: 'text', text: 'a [[webhook:wh_01|X]] b' },
    ])
  })

  it('leaves single brackets, malformed tokens and multi-line labels alone', () => {
    expect(tokensIn('[company:com_01] [[company:]] [[company com_01]] [[person:per_01|Ada\nL]]')).toEqual([])
  })
})

describe('formatRecordLinkToken', () => {
  it('writes a labelled and an unlabelled token', () => {
    expect(formatRecordLinkToken({ targetType: 'company', targetId: 'com_01', label: 'Acme' })).toBe(
      '[[company:com_01|Acme]]',
    )
    expect(formatRecordLinkToken({ targetType: 'role', targetId: 'role_01' })).toBe('[[role:role_01]]')
  })

  it('strips characters that would end the token early, and round-trips', () => {
    const token = formatRecordLinkToken({ targetType: 'deal', targetId: 'deal_01', label: 'Big | deal ]] now' })

    expect(token).toBe('[[deal:deal_01|Big deal now]]')
    expect(tokensIn(token)).toEqual([{ targetType: 'deal', targetId: 'deal_01', label: 'Big deal now' }])
  })
})

describe('recordReferenceSchema', () => {
  it('accepts a Role and a handbook page', () => {
    expect(recordReferenceSchema.parse({ target_type: 'role', target_id: 'role_01', name: 'Engineer' })).toEqual({
      targetType: 'role',
      targetId: 'role_01',
      name: 'Engineer',
      parent: null,
    })
    expect(
      recordReferenceSchema.parse({ target_type: 'handbook_page', target_id: 'hb_01', name: 'Voice' }).targetType,
    ).toBe('handbook_page')
  })

  it('reads the record a note is on as its parent', () => {
    expect(
      recordReferenceSchema.parse({
        target_type: 'note',
        target_id: 'note_01',
        name: 'Call went well',
        parent_type: 'company',
        parent_id: 'com_01',
      }).parent,
    ).toEqual({ type: 'company', id: 'com_01' })
  })

  it('refuses a type that cannot be cited', () => {
    expect(() => recordReferenceSchema.parse({ target_type: 'webhook', target_id: 'wh_01', name: 'X' })).toThrow()
  })
})

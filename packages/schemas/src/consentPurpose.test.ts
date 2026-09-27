import { describe, expect, it } from 'vitest'

import { consentCheckboxText, consentPurposeSchema, expandConsentStatement } from './consentPurpose.ts'

describe('expandConsentStatement', () => {
  it('replaces every {{workspace}} token', () => {
    expect(expandConsentStatement('{{workspace}} and {{workspace}}', 'Acme')).toBe('Acme and Acme')
  })

  it('leaves other tokens alone', () => {
    expect(expandConsentStatement('{{company.name}}', 'Acme')).toBe('{{company.name}}')
  })
})

describe('consentCheckboxText', () => {
  const purpose = { label: 'Marketing', statement: 'I consent to {{workspace}} emailing me.' }

  it('uses the statement before the label', () => {
    expect(consentCheckboxText(undefined, purpose, 'Acme')).toBe('I consent to Acme emailing me.')
  })

  it('uses the label when the statement is blank', () => {
    expect(consentCheckboxText(undefined, { label: 'Marketing', statement: '  ' }, 'Acme')).toBe(
      'Marketing',
    )
  })

  it('uses the override before both', () => {
    expect(consentCheckboxText('Send me {{workspace}} news', purpose, 'Acme')).toBe(
      'Send me Acme news',
    )
  })
})

describe('consentPurposeSchema', () => {
  it('reads statement off the wire', () => {
    const parsed = consentPurposeSchema.parse({
      id: 'cp_1',
      slug: 'marketing',
      label: 'Marketing',
      description: '',
      statement: 'I consent to {{workspace}} emailing me.',
      default_status: 'unknown',
      sort_order: 0,
      created_at: '2026-09-28T00:00:00.000Z',
      updated_at: '2026-09-28T00:00:00.000Z',
    })

    expect(parsed.statement).toBe('I consent to {{workspace}} emailing me.')
  })
})

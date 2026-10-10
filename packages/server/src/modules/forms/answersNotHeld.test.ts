import { FORM_STANDARD_MAP_FIELDS } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { answersNotHeld } from './answersNotHeld.ts'
import type { ExistingRecordType } from './answersNotHeld.ts'

const RECORD_TYPES: readonly ExistingRecordType[] = ['person', 'company', 'position', 'raise']

describe('answersNotHeld', () => {
  it('knows the column of every standard field of the records it compares', () => {
    // A field with no column is reported as not held whatever the record
    // says. A record that holds each sample must then report nothing.
    const samples: Readonly<Record<string, { readonly answer: string; readonly stored: unknown }>> = {
      text: { answer: 'a', stored: 'a' },
      long_text: { answer: 'a', stored: 'a' },
      enum: { answer: 'a', stored: 'a' },
      date: { answer: '2026-01-31', stored: '2026-01-31' },
      email: { answer: 'a@example.com', stored: 'a@example.com' },
      phones: { answer: '555-1234', stored: ['555-1234'] },
      tags: { answer: 'a, b', stored: ['b', 'a'] },
      string_array: { answer: 'a, b', stored: ['a', 'b'] },
      boolean: { answer: 'true', stored: true },
      number: { answer: '5', stored: 5 },
    }
    const reported: string[] = []

    for (const objectType of RECORD_TYPES) {
      for (const entry of FORM_STANDARD_MAP_FIELDS[objectType]) {
        if (entry.field.startsWith('address.')) continue

        const sample = samples[entry.valueType]

        if (sample === undefined) {
          reported.push(`${objectType}.${entry.field}: no sample for ${entry.valueType}`)
          continue
        }

        const camel = entry.field.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
        const target = `${objectType}.${entry.field}`

        reported.push(...answersNotHeld(objectType, { [camel]: sample.stored }, { [target]: sample.answer }, []))
      }
    }

    expect(reported).toEqual([])
  })

  it('reports a typed value where the record has a blank', () => {
    const mapped = { 'person.salutation': 'Dr', 'person.phones': '555-1234', 'person.tags': 'vip' }

    expect(
      answersNotHeld('person', { salutation: null, phones: [], tags: [] }, mapped, []),
    ).toEqual(['person.salutation', 'person.phones', 'person.tags'])
  })

  it('compares names exactly, and a domain through its normaliser', () => {
    expect(answersNotHeld('person', { name: 'Jane Smith' }, { 'person.name': 'jane smith' }, [])).toEqual([
      'person.name',
    ])
    expect(
      answersNotHeld('company', { domain: 'example.com' }, { 'company.domain': 'https://Example.com/pricing' }, []),
    ).toEqual([])
  })
})

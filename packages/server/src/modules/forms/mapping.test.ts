import { describe, expect, it } from 'vitest'

import {
  companyNameFrom,
  describeAnswers,
  expandNameTemplate,
  expectedCloseFrom,
  fillBlank,
  findAnswerProblems,
  mapAnswers,
  readIntent,
} from './mapping.ts'
import type { FormFieldRecord } from './repository.ts'
import type { FormFieldMapTarget, FormFieldType, StoredFormFieldOption } from './schema.ts'

/**
 * The submit rules from `forms.md` that need no database.
 *
 * These decide what an inbound answer map becomes before a single row is
 * written, so they are the cheapest place to pin the behaviour the mockup's
 * `processFormSubmission` established.
 */

interface FieldOverrides {
  readonly id?: string
  readonly label?: string
  readonly type?: FormFieldType
  readonly required?: boolean
  readonly mapTo?: FormFieldMapTarget
  readonly options?: readonly StoredFormFieldOption[]
}

function field(overrides: FieldOverrides = {}): FormFieldRecord {
  const stamp = new Date('2026-08-04T00:00:00.000Z')

  return {
    id: overrides.id ?? 'ff_email',
    workspaceId: 'ws_1',
    formId: 'form_1',
    label: overrides.label ?? 'Email',
    type: overrides.type ?? 'email',
    required: overrides.required ?? false,
    mapTo: overrides.mapTo ?? 'person.email',
    options: overrides.options ?? [],
    placeholder: null,
    sortOrder: 0,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

const emailField = field()
const nameField = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name' })
const companyField = field({ id: 'ff_co', label: 'Company', type: 'text', mapTo: 'company.name' })

describe('mapAnswers', () => {
  it('keys answers by what they write rather than by which field carried them', () => {
    const mapped = mapAnswers([emailField, nameField], {
      ff_email: 'alex@example.com',
      ff_name: 'Alex Rivera',
    })

    expect(mapped).toEqual({ 'person.email': 'alex@example.com', 'person.name': 'Alex Rivera' })
  })

  it('trims, and drops an answer that was only whitespace', () => {
    const mapped = mapAnswers([emailField, nameField], {
      ff_email: '  alex@example.com  ',
      ff_name: '   ',
    })

    expect(mapped).toEqual({ 'person.email': 'alex@example.com' })
  })
})

describe('findAnswerProblems', () => {
  it('accepts a complete answer map', () => {
    expect(findAnswerProblems([emailField, nameField], { ff_email: 'a@b.com' })).toEqual([])
  })

  it('reports a field the form does not have', () => {
    const problems = findAnswerProblems([emailField], { ff_email: 'a@b.com', ff_nope: 'x' })

    expect(problems).toEqual([{ field: 'answers.ff_nope', message: 'Unknown field' }])
  })

  it('treats a blank answer to a required field as missing', () => {
    const required = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name', required: true })
    const problems = findAnswerProblems([emailField, required], { ff_email: 'a@b.com', ff_name: '  ' })

    expect(problems).toEqual([{ field: 'answers.ff_name', message: 'Name is required' }])
  })

  it('accepts a select answer that is one of the option keys', () => {
    const select = field({
      id: 'ff_size',
      label: 'Team size',
      type: 'select',
      mapTo: 'submission',
      options: [{ key: 'small', value: '1-10', valueType: 'string' }],
    })

    expect(findAnswerProblems([emailField, select], { ff_email: 'a@b.com', ff_size: 'small' })).toEqual([])
  })

  /** The display value is not the handle; only the key is, so only the key is accepted. */
  it('refuses a select answer that is an option label rather than its key', () => {
    const select = field({
      id: 'ff_size',
      label: 'Team size',
      type: 'select',
      mapTo: 'submission',
      options: [{ key: 'small', value: '1-10', valueType: 'string' }],
    })
    const problems = findAnswerProblems([emailField, select], { ff_email: 'a@b.com', ff_size: '1-10' })

    expect(problems).toEqual([
      { field: 'answers.ff_size', message: 'Team size does not offer that choice' },
    ])
  })

  it('reports every problem at once rather than the first', () => {
    const required = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name', required: true })
    const problems = findAnswerProblems([emailField, required], { ff_ghost: 'x' })

    expect(problems).toHaveLength(2)
  })
})

describe('readIntent', () => {
  it('falls back to the part of the address before the @ when no name was given', () => {
    const intent = readIntent({ 'person.email': 'alex@example.com' })

    expect(intent?.personName).toBe('alex')
  })

  it('composes the name from a first and last name pair, which most forms ask for', () => {
    const intent = readIntent({
      'person.email': 'alex@example.com',
      'person.first_name': 'Alex',
      'person.last_name': 'Rivera',
    })

    expect(intent?.personName).toBe('Alex Rivera')
    // Kept as parts too, so the Person carries them rather than only the
    // sentence they were joined into.
    expect(intent?.personFirstName).toBe('Alex')
    expect(intent?.personLastName).toBe('Rivera')
  })

  it('composes from a first name alone rather than falling back to the address', () => {
    const intent = readIntent({ 'person.email': 'alex@example.com', 'person.first_name': 'Alex' })

    expect(intent?.personName).toBe('Alex')
  })

  it('prefers a whole name answer over the parts when the form asked for both', () => {
    const intent = readIntent({
      'person.email': 'alex@example.com',
      'person.name': 'Alex Rivera-Nakamura',
      'person.first_name': 'Alex',
      'person.last_name': 'Rivera',
    })

    expect(intent?.personName).toBe('Alex Rivera-Nakamura')
  })

  it('normalises the address', () => {
    const intent = readIntent({ 'person.email': '  Alex@Example.COM ' })

    expect(intent?.email).toBe('alex@example.com')
  })

  it('refuses a value that is not an address', () => {
    expect(readIntent({ 'person.email': 'alex' })).toBeUndefined()
  })

  it('refuses an answer map with no address at all', () => {
    expect(readIntent({ 'person.name': 'Alex' })).toBeUndefined()
  })

  it('normalises a domain down to its host', () => {
    const intent = readIntent({
      'person.email': 'a@b.com',
      'company.domain': 'HTTPS://WWW.Example.com/pricing',
    })

    expect(intent?.companyDomain).toBe('www.example.com')
  })

  /**
   * An email domain is not a company identifier. One company sends from several,
   * a consumer address belongs to none, and two people at unrelated businesses
   * can share one, so deriving a company from it merges records that were never
   * the same company.
   */
  it('never takes the company domain from the address', () => {
    const named = readIntent({ 'person.email': 'alex@example.com', 'company.name': 'Example Co' })
    const bare = readIntent({ 'person.email': 'alex@example.com' })

    expect(named?.companyDomain).toBeUndefined()
    expect(bare?.companyDomain).toBeUndefined()
  })

  it('uses the domain that was actually asked for', () => {
    const intent = readIntent({
      'person.email': 'alex@sales.example.com',
      'company.name': 'Example Co',
      'company.domain': 'example.com',
    })

    expect(intent?.companyDomain).toBe('example.com')
  })
})

describe('fillBlank', () => {
  it('fills a stored null', () => {
    expect(fillBlank(null, 'Alex Rivera')).toBe('Alex Rivera')
  })

  it('fills a stored empty string', () => {
    expect(fillBlank('   ', 'Alex Rivera')).toBe('Alex Rivera')
  })

  it('leaves a stored value alone, which is the whole point of the rule', () => {
    expect(fillBlank('Alex Rivera', 'Alex')).toBeUndefined()
  })

  it('writes nothing when the answer was absent', () => {
    expect(fillBlank(null, undefined)).toBeUndefined()
  })
})

describe('companyNameFrom', () => {
  const base = {
    email: 'a@b.com',
    personName: 'a',
    personFirstName: undefined,
    personLastName: undefined,
    positionTitle: undefined,
    dealName: undefined,
    opportunityName: undefined,
    partnershipName: undefined,
    enquiryName: undefined,
  } as const

  it('prefers the name that was given', () => {
    expect(companyNameFrom({ ...base, companyName: 'Example Co', companyDomain: 'example.com' })).toBe(
      'Example Co',
    )
  })

  it('names a company after its domain when only a domain arrived', () => {
    expect(companyNameFrom({ ...base, companyName: undefined, companyDomain: 'example.com' })).toBe(
      'example.com',
    )
  })

  it('is undefined when the answers said nothing about a company', () => {
    expect(
      companyNameFrom({ ...base, companyName: undefined, companyDomain: undefined }),
    ).toBeUndefined()
  })
})

describe('expandNameTemplate', () => {
  it('substitutes both placeholders', () => {
    const name = expandNameTemplate('{{company.name}} — {{person.name}}', {
      companyName: 'Example Co',
      personName: 'Alex Rivera',
    })

    expect(name).toBe('Example Co — Alex Rivera')
  })

  it('substitutes a placeholder used more than once', () => {
    const name = expandNameTemplate('{{person.name}} and {{person.name}}', {
      companyName: '',
      personName: 'Alex',
    })

    expect(name).toBe('Alex and Alex')
  })

  it('leaves a readable name when a value is missing', () => {
    expect(expandNameTemplate('{{company.name}}', { companyName: '', personName: '' })).toBe(
      'Website lead',
    )
  })
})

describe('expectedCloseFrom', () => {
  it('answers a date-only string 30 days on', () => {
    expect(expectedCloseFrom(new Date('2026-08-04T11:30:00.000Z'), 30)).toBe('2026-09-03')
  })

  it('crosses a year boundary', () => {
    expect(expectedCloseFrom(new Date('2026-12-20T00:00:00.000Z'), 30)).toBe('2027-01-19')
  })
})

describe('describeAnswers', () => {
  it('takes the first three answered fields, in form order', () => {
    const detail = describeAnswers([nameField, emailField, companyField], {
      ff_name: 'Alex',
      ff_email: 'alex@example.com',
      ff_co: 'Example Co',
    })

    expect(detail).toBe('Name: Alex · Email: alex@example.com · Company: Example Co')
  })

  it('skips fields nobody filled in', () => {
    expect(describeAnswers([nameField, emailField], { ff_name: '  ', ff_email: 'a@b.com' })).toBe(
      'Email: a@b.com',
    )
  })

  it('is null when there is nothing to say', () => {
    expect(describeAnswers([nameField], {})).toBeNull()
  })
})

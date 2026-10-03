import { describe, expect, it } from 'vitest'

import {
  companyNameFrom,
  describeAnswers,
  expandNameTemplate,
  expectedCloseFrom,
  fillBlank,
  fillPhonesBlank,
  findAnswerProblems,
  findUnknownAnswers,
  mapAnswers,
  readIntent,
  readListChoices,
} from './mapping.ts'
import type { FormFieldRecord } from './repository.ts'
import type { FormFieldMapTarget, FormFieldType, StoredFormFieldOption } from './schema.ts'

/**
 * The submit rules that need no database.
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
  readonly listIds?: readonly string[]
  readonly consentPurposeIds?: readonly string[]
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
    statement: null,
    consentPurposeIds: [...(overrides.consentPurposeIds ?? [])],
    consentPurposeLabels: {},
    listIds: [...(overrides.listIds ?? [])],
    listLabels: {},
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

describe('an Add to list field', () => {
  const newsField = field({
    id: 'ff_lists',
    label: 'Add me to the mailing list',
    type: 'list',
    mapTo: 'lists',
    listIds: ['list_news', 'list_events'],
  })

  it('writes nothing through mapAnswers', () => {
    expect(mapAnswers([emailField, newsField], { ff_email: 'a@b.co', ff_lists: 'list_news' })).toEqual({
      'person.email': 'a@b.co',
    })
  })

  it('reads the ticked lists the field offers, each once, and drops the rest', () => {
    const other = field({ id: 'ff_more', type: 'list', mapTo: 'lists', listIds: ['list_news', 'list_vip'] })

    expect(
      readListChoices([emailField, newsField, other], {
        ff_lists: 'list_events, list_news,list_unknown',
        ff_more: 'list_news,list_vip',
      }),
    ).toEqual(['list_events', 'list_news', 'list_vip'])
  })

  it('reads nothing when no box is ticked', () => {
    expect(readListChoices([newsField], {})).toEqual([])
  })

  it('needs one offered list ticked when required', () => {
    const required = { ...newsField, required: true }

    expect(findAnswerProblems([required], { ff_lists: 'list_unknown' })).toEqual([
      { field: 'answers.ff_lists', message: 'Tick at least one box to continue' },
    ])
    expect(findAnswerProblems([required], { ff_lists: 'list_news' })).toEqual([])
    expect(findAnswerProblems([newsField], {})).toEqual([])
  })

  it('asks for "the box" when a required field offers one list', () => {
    const single = field({
      id: 'ff_lists',
      label: 'Add me to the mailing list',
      type: 'list',
      mapTo: 'lists',
      required: true,
      listIds: ['list_news'],
    })

    expect(findAnswerProblems([single], {})).toEqual([
      { field: 'answers.ff_lists', message: 'Tick the box to continue' },
    ])
  })
})

describe('a required consent field', () => {
  function consentField(consentPurposeIds: readonly string[]): FormFieldRecord {
    return field({
      id: 'ff_consent',
      label: 'Keep in touch',
      type: 'consent',
      mapTo: 'person.consent',
      required: true,
      consentPurposeIds,
    })
  }

  it('asks for "the box" when it offers one purpose', () => {
    expect(findAnswerProblems([consentField(['cp_news'])], {})).toEqual([
      { field: 'answers.ff_consent', message: 'Tick the box to continue' },
    ])
  })

  it('asks for "at least one box" when it offers several purposes', () => {
    expect(findAnswerProblems([consentField(['cp_news', 'cp_events'])], { ff_consent: '' })).toEqual([
      { field: 'answers.ff_consent', message: 'Tick at least one box to continue' },
    ])
  })

  it('accepts one ticked purpose', () => {
    expect(findAnswerProblems([consentField(['cp_news', 'cp_events'])], { ff_consent: 'cp_events' })).toEqual([])
  })
})

describe('a required field with no label', () => {
  it('calls itself "This field" in the error', () => {
    const unlabelled = field({ id: 'ff_name', label: '', type: 'text', mapTo: 'person.name', required: true })

    expect(findAnswerProblems([unlabelled], {})).toEqual([
      { field: 'answers.ff_name', message: 'This field is required' },
    ])
  })
})

describe('findAnswerProblems', () => {
  it('accepts a complete answer map', () => {
    expect(findAnswerProblems([emailField, nameField], { ff_email: 'a@b.com' })).toEqual([])
  })

  it('does not report an answer for a field the form does not have', () => {
    // findUnknownAnswers reports that, and the submit refuses it as a 409
    // before this runs. Reporting it here too would turn a stale page into a
    // 422 with "is required" errors for fields the page never showed.
    const required = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name', required: true })
    const problems = findAnswerProblems([emailField, required], { ff_email: 'a@b.com', ff_nope: 'x' })

    expect(problems).toEqual([{ field: 'answers.ff_name', message: 'Name is required' }])
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
    const requiredEmail = field({ required: true })
    const required = field({ id: 'ff_name', label: 'Name', type: 'text', mapTo: 'person.name', required: true })
    const problems = findAnswerProblems([requiredEmail, required], {})

    expect(problems).toHaveLength(2)
  })
})

describe('findUnknownAnswers', () => {
  it('names each answer for a field the form does not have', () => {
    // A page left open while the form's field list was changed and saved
    // sends the old field ids, like these.
    const problems = findUnknownAnswers([emailField], { ff_email: 'a@b.com', ff_nope: 'x', ff_gone: '' })

    expect(problems).toEqual([
      { field: 'answers.ff_nope', message: 'This form no longer has this field' },
      { field: 'answers.ff_gone', message: 'This form no longer has this field' },
    ])
  })

  it('finds nothing when every answer is for a field the form has', () => {
    expect(findUnknownAnswers([emailField, nameField], { ff_email: 'a@b.com' })).toEqual([])
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

  it('reads a phone answer from person.phones', () => {
    const intent = readIntent({
      'person.email': 'alex@example.com',
      'person.phones': '+61 400 000 000',
    })

    expect(intent?.personPhone).toBe('+61 400 000 000')
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

describe('fillPhonesBlank', () => {
  it('fills an empty stored list', () => {
    expect(fillPhonesBlank([], '+61 400 000 000')).toEqual(['+61 400 000 000'])
  })

  it('leaves a stored list alone', () => {
    expect(fillPhonesBlank(['+61 400 000 000'], '+61 411 111 111')).toBeUndefined()
  })

  it('writes nothing when the answer was absent', () => {
    expect(fillPhonesBlank([], undefined)).toBeUndefined()
  })
})

describe('companyNameFrom', () => {
  const base = {
    email: 'a@b.com',
    personName: 'a',
    personFirstName: undefined,
    personLastName: undefined,
    personPhone: undefined,
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

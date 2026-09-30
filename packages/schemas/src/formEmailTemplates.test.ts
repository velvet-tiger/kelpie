import { describe, expect, it } from 'vitest'

import {
  FORM_EMAIL_PLACEHOLDERS,
  fillFormEmailTemplate,
  findTemplatePlaceholderProblems,
  isPlaceholderAllowed,
  readTemplatePlaceholders,
} from './formEmailTemplates.ts'

describe('readTemplatePlaceholders', () => {
  it('reads every placeholder in order, with spaces inside the braces trimmed', () => {
    expect(readTemplatePlaceholders('Hi {{person.name}}, from {{ form.name }} ({{person.name}})')).toEqual([
      'person.name',
      'form.name',
      'person.name',
    ])
  })

  it('ignores braces that do not close', () => {
    expect(readTemplatePlaceholders('Price: {{ and {single}')).toEqual([])
  })
})

describe('isPlaceholderAllowed', () => {
  it('allows every listed placeholder in a notification', () => {
    for (const placeholder of FORM_EMAIL_PLACEHOLDERS) {
      expect(isPlaceholderAllowed(placeholder.name, 'notification')).toBe(true)
    }
  })

  it('allows only the both-scope placeholders in an auto-reply', () => {
    const allowed = FORM_EMAIL_PLACEHOLDERS.filter((placeholder) =>
      isPlaceholderAllowed(placeholder.name, 'auto_reply'),
    ).map((placeholder) => placeholder.name)

    expect(allowed).toEqual(['form.name', 'form.title', 'workspace.name', 'submitted_at'])
  })

  it('refuses a name that is not in the list', () => {
    expect(isPlaceholderAllowed('field.ff_01', 'notification')).toBe(false)
  })
})

describe('findTemplatePlaceholderProblems', () => {
  it('finds nothing in a template of allowed placeholders', () => {
    expect(findTemplatePlaceholderProblems('{{form.name}}: {{answers}}', 'notification')).toEqual([])
  })

  it('names an unknown placeholder once, however often it repeats', () => {
    expect(findTemplatePlaceholderProblems('{{nope}} and {{nope}}', 'notification')).toEqual([
      '{{nope}} is not a placeholder',
    ])
  })

  it('says why visitor text is refused in an auto-reply', () => {
    expect(findTemplatePlaceholderProblems('Hi {{person.name}}, re {{answers}}', 'auto_reply')).toEqual([
      '{{person.name}} is text the visitor typed, which an auto-reply cannot include',
      '{{answers}} is text the visitor typed, which an auto-reply cannot include',
    ])
  })
})

describe('fillFormEmailTemplate', () => {
  it('replaces each placeholder, and one with no value with nothing', () => {
    const values: Record<string, string> = { 'form.name': 'Contact' }

    expect(fillFormEmailTemplate('New: {{ form.name }} from {{person.name}}.', (name) => values[name])).toBe(
      'New: Contact from .',
    )
  })

  it('does not fill placeholders inside a filled value', () => {
    const values: Record<string, string> = { answers: 'Message: {{form.name}}', 'form.name': 'Contact' }

    expect(fillFormEmailTemplate('{{answers}}', (name) => values[name])).toBe('Message: {{form.name}}')
  })
})

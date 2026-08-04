import type { FormFieldInput } from '@kelpie/schemas'

/**
 * What a new form starts as: the mockup's contact template.
 *
 * Not an empty list. A form with no `person.email` mapping is one the API
 * refuses, so "create then edit" would mean creating something invalid; and a
 * contact form is what almost everybody is about to build anyway.
 */
export const CONTACT_FORM_FIELDS: readonly FormFieldInput[] = [
  { label: 'Name', type: 'text', required: true, mapTo: 'person.name', placeholder: 'Your name' },
  {
    label: 'Email',
    type: 'email',
    required: true,
    mapTo: 'person.email',
    placeholder: 'you@company.com',
  },
  { label: 'Company', type: 'text', mapTo: 'company.name', placeholder: 'Company name' },
  { label: 'Job title', type: 'text', mapTo: 'position.title', placeholder: 'Your role' },
  { label: 'Message', type: 'textarea', mapTo: 'submission', placeholder: 'How can we help?' },
]

/** A field added by hand: submission-only, so it cannot collide with a mapping already in use. */
export const NEW_FIELD: FormFieldInput = {
  label: 'New field',
  type: 'text',
  required: false,
  mapTo: 'submission',
  placeholder: null,
}

/** What a select starts with, so it is valid the moment the type is chosen. */
export const NEW_SELECT_OPTIONS = [
  { key: 'option_a', value: 'Option A', valueType: 'string' as const },
  { key: 'option_b', value: 'Option B', valueType: 'string' as const },
]

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

/**
 * One ready-made field per CRM mapping target, in the target enum's order.
 *
 * "Add field" offers these so adding the company field is one click, not
 * add-then-configure. Only one field may carry a CRM target, so the menu shows
 * each preset only while its target is free — `unusedCrmPresets` in
 * `fieldList.ts` does that filtering.
 */
export const CRM_FIELD_PRESETS: readonly FormFieldInput[] = [
  { label: 'Name', type: 'text', required: false, mapTo: 'person.name', placeholder: 'Your name' },
  // The other way to ask for a name. A form takes one box or this pair; the
  // menu hides whichever is already mapped, so both are offered and neither
  // ends up used twice.
  {
    label: 'First name',
    type: 'text',
    required: false,
    mapTo: 'person.first_name',
    placeholder: 'First name',
  },
  {
    label: 'Last name',
    type: 'text',
    required: false,
    mapTo: 'person.last_name',
    placeholder: 'Last name',
  },
  {
    label: 'Email',
    type: 'email',
    required: true,
    mapTo: 'person.email',
    placeholder: 'you@company.com',
  },
  {
    label: 'Phone',
    type: 'text',
    required: false,
    mapTo: 'person.phones',
    placeholder: 'Phone number',
  },
  { label: 'Company', type: 'text', required: false, mapTo: 'company.name', placeholder: 'Company name' },
  {
    label: 'Company website',
    type: 'text',
    required: false,
    mapTo: 'company.domain',
    placeholder: 'company.com',
  },
  { label: 'Job title', type: 'text', required: false, mapTo: 'position.title', placeholder: 'Your role' },
  { label: 'Enquiry name', type: 'text', required: false, mapTo: 'enquiry.name', placeholder: null },
  { label: 'Deal name', type: 'text', required: false, mapTo: 'deal.name', placeholder: null },
  { label: 'Opportunity name', type: 'text', required: false, mapTo: 'opportunity.name', placeholder: null },
  { label: 'Partnership name', type: 'text', required: false, mapTo: 'partnership.name', placeholder: null },
]

/** A submission-only entry in the "Add field" menu: shown by control, not by mapping. */
export interface SubmissionFieldPreset {
  /** What the menu shows. The field itself starts with its own label. */
  readonly menuLabel: string
  readonly field: FormFieldInput
}

/** The submission-only fields "Add field" always offers; they may repeat freely. */
export const SUBMISSION_FIELD_PRESETS: readonly SubmissionFieldPreset[] = [
  { menuLabel: 'Text', field: NEW_FIELD },
  {
    menuLabel: 'Text area',
    field: { label: 'Message', type: 'textarea', required: false, mapTo: 'submission', placeholder: null },
  },
  {
    menuLabel: 'Select',
    field: {
      label: 'New select',
      type: 'select',
      required: false,
      mapTo: 'submission',
      placeholder: null,
      options: NEW_SELECT_OPTIONS,
    },
  },
  {
    menuLabel: 'Consent',
    field: {
      label: 'Consent',
      type: 'consent',
      required: false,
      mapTo: 'person.consent',
      placeholder: null,
      statement: 'Please tell us how we can contact you.',
      consentPurposeIds: [],
      consentPurposeLabels: {},
    },
  },
  {
    menuLabel: 'Notice',
    field: {
      label: 'Privacy notice',
      type: 'notice',
      required: false,
      mapTo: 'person.consent',
      placeholder: null,
      statement:
        'By submitting this form you agree to us storing your information and using it to contact you about your enquiry.',
      consentPurposeIds: [],
      consentPurposeLabels: {},
    },
  },
]

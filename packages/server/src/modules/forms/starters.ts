import type { FormFieldMapTarget, FormFieldType } from '@kelpie/schemas'

/**
 * The forms a new workspace starts with. Data, not migrations: a workspace
 * owner may rename, pause, or delete them, and add any others they need.
 *
 * Consent fields name a purpose by slug; `seedStarterForms` resolves those to
 * the ids assigned when `STARTER_CONSENT_PURPOSES` is inserted.
 */

export type StarterFormSlug = 'contact' | 'newsletter'

export type StarterConsentPurposeSlug = 'contact' | 'marketing'

export type StarterListSlug = 'newsletter'

export interface StarterFormField {
  readonly label: string
  readonly type: FormFieldType
  readonly required: boolean
  readonly mapTo: FormFieldMapTarget
  readonly placeholder?: string | null
  readonly statement?: string
  readonly consentPurposeSlug?: StarterConsentPurposeSlug
}

export interface StarterForm {
  readonly slug: StarterFormSlug
  readonly name: string
  readonly title: string
  readonly description: string
  readonly thankYouMessage: string
  readonly linkedListSlug?: StarterListSlug
  readonly fields: readonly StarterFormField[]
}

export const STARTER_FORMS: readonly StarterForm[] = [
  {
    slug: 'contact',
    name: 'Contact',
    title: 'Contact us',
    description: 'General enquiries from your website.',
    thankYouMessage: 'Thanks. We will be in touch.',
    fields: [
      {
        label: 'Name',
        type: 'text',
        required: true,
        mapTo: 'person.name',
        placeholder: 'Your name',
      },
      {
        label: 'Email',
        type: 'email',
        required: true,
        mapTo: 'person.email',
        placeholder: 'you@company.com',
      },
      {
        label: 'Job title',
        type: 'text',
        required: false,
        mapTo: 'position.title',
        placeholder: 'Your role',
      },
      {
        label: 'Company',
        type: 'text',
        required: false,
        mapTo: 'company.name',
        placeholder: 'Company name',
      },
      {
        label: 'Phone',
        type: 'text',
        required: false,
        mapTo: 'person.phones',
        placeholder: 'Phone number',
      },
      {
        label: 'Message',
        type: 'textarea',
        required: false,
        mapTo: 'submission',
        placeholder: 'How can we help?',
      },
      {
        label: 'Consent',
        type: 'consent',
        required: true,
        mapTo: 'person.consent',
        statement: 'Please tell us how we can contact you about your enquiry.',
        consentPurposeSlug: 'contact',
      },
    ],
  },
  {
    slug: 'newsletter',
    name: 'Newsletter',
    title: 'Newsletter signup',
    description: 'Subscribe to product updates and campaigns.',
    thankYouMessage: 'Thanks for subscribing.',
    linkedListSlug: 'newsletter',
    fields: [
      {
        label: 'Name',
        type: 'text',
        required: false,
        mapTo: 'person.name',
        placeholder: 'Your name',
      },
      {
        label: 'Email',
        type: 'email',
        required: true,
        mapTo: 'person.email',
        placeholder: 'you@company.com',
      },
      {
        label: 'Consent',
        type: 'consent',
        required: true,
        mapTo: 'person.consent',
        statement: 'Please confirm you want to hear from us.',
        consentPurposeSlug: 'marketing',
      },
    ],
  },
]

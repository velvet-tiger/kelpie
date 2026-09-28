import { describe, expect, it } from 'vitest'

import { createFormBody, formBody, formFieldDisplayLabel, formSchema } from './form.ts'
import type { CreateFormInput, FormInput } from './form.ts'

function wireField(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'field_01hx',
    label: 'Work email',
    type: 'email',
    required: true,
    map_to: 'person.email',
    options: [],
    placeholder: 'you@company.com',
    statement: null,
    consent_purpose_ids: [],
    consent_purpose_labels: {},
    list_ids: [],
    list_labels: {},
    sort_order: 0,
    ...overrides,
  }
}

function wireForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'form_01hx',
    name: 'Contact us',
    title: 'Contact us',
    description: 'Public site contact form.',
    status: 'active',
    fields: [wireField()],
    thank_you_message: 'Thanks, we will be in touch.',
    create_deal: true,
    deal_stage_id: 'stage_01hx',
    deal_name_template: '{{company.name}} inbound',
    create_opportunity: false,
    opportunity_kind: null,
    opportunity_stage_id: null,
    opportunity_name_template: null,
    opportunity_owner_id: null,
    create_partnership: false,
    partnership_kind: null,
    partnership_stage_id: null,
    partnership_name_template: null,
    partnership_owner_id: null,
    create_enquiry: false,
    enquiry_source: null,
    enquiry_stage_id: null,
    enquiry_name_template: null,
    enquiry_owner_id: null,
    person_tags: [],
    company_tags: [],
    list_ids: [],
    attach_targets: [],
    slug: 'contact',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('formSchema', () => {
  it('maps a form and its nested fields to camelCase', () => {
    const form = formSchema.parse(wireForm())

    expect(form).toEqual({
      id: 'form_01hx',
      name: 'Contact us',
      title: 'Contact us',
      description: 'Public site contact form.',
      status: 'active',
      fields: [
        {
          id: 'field_01hx',
          label: 'Work email',
          type: 'email',
          required: true,
          mapTo: 'person.email',
          options: [],
          placeholder: 'you@company.com',
          statement: null,
          consentPurposeIds: [],
          consentPurposeLabels: {},
          listIds: [],
          listLabels: {},
          sortOrder: 0,
        },
      ],
      thankYouMessage: 'Thanks, we will be in touch.',
      createDeal: true,
      dealStageId: 'stage_01hx',
      dealNameTemplate: '{{company.name}} inbound',
      createOpportunity: false,
      opportunityKind: null,
      opportunityStageId: null,
      opportunityNameTemplate: null,
      opportunityOwnerId: null,
      createPartnership: false,
      partnershipKind: null,
      partnershipStageId: null,
      partnershipNameTemplate: null,
      partnershipOwnerId: null,
      createEnquiry: false,
      enquirySource: null,
      enquiryStageId: null,
      enquiryNameTemplate: null,
      enquiryOwnerId: null,
      personTags: [],
      companyTags: [],
      listIds: [],
      attachTargets: [],
      slug: 'contact',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
  })

  it('maps select field options to camelCase valueType', () => {
    const form = formSchema.parse(
      wireForm({
        fields: [
          wireField({
            type: 'select',
            options: [{ key: 'yes', value: 'Yes', value_type: 'boolean' }],
          }),
        ],
      }),
    )

    expect(form.fields[0]?.options).toEqual([{ key: 'yes', value: 'Yes', valueType: 'boolean' }])
  })

  it('maps an Add to list field with its lists and checkbox labels', () => {
    const form = formSchema.parse(
      wireForm({
        fields: [
          wireField({
            label: 'Add me to the mailing list',
            type: 'list',
            required: false,
            map_to: 'lists',
            statement: 'One email a month.',
            list_ids: ['list_news', 'list_events'],
            list_labels: { list_news: 'Yes!' },
          }),
        ],
      }),
    )

    expect(form.fields[0]).toMatchObject({
      type: 'list',
      mapTo: 'lists',
      statement: 'One email a month.',
      listIds: ['list_news', 'list_events'],
      listLabels: { list_news: 'Yes!' },
    })
  })

  it('carries description, dealStageId, and dealNameTemplate through as null', () => {
    const form = formSchema.parse(
      wireForm({ description: null, deal_stage_id: null, deal_name_template: null }),
    )

    expect(form.description).toBeNull()
    expect(form.dealStageId).toBeNull()
    expect(form.dealNameTemplate).toBeNull()
  })

  it('accepts a form with no fields', () => {
    expect(formSchema.parse(wireForm({ fields: [] })).fields).toEqual([])
  })

  it('rejects a status outside FORM_STATUSES', () => {
    expect(() => formSchema.parse(wireForm({ status: 'archived' }))).toThrow()
  })

  it('rejects a field whose map_to is empty', () => {
    expect(() => formSchema.parse(wireForm({ fields: [wireField({ map_to: '' })] }))).toThrow()
  })

  it('accepts expanded map targets as strings', () => {
    expect(
      formSchema.parse(wireForm({ fields: [wireField({ map_to: 'person.summary' })] })).fields[0]
        ?.mapTo,
    ).toBe('person.summary')
  })

  it('rejects a non-integer sort_order', () => {
    expect(() => formSchema.parse(wireForm({ fields: [wireField({ sort_order: 1.5 })] }))).toThrow()
  })
})

describe('formFieldDisplayLabel', () => {
  it('uses the label, or the map target name when the label is empty', () => {
    expect(formFieldDisplayLabel({ label: 'Work email', mapTo: 'person.email' })).toBe('Work email')
    expect(formFieldDisplayLabel({ label: ' ', mapTo: 'person.email' })).toBe('Person · email')
    expect(formFieldDisplayLabel({ label: '', mapTo: 'lists' })).toBe('Lists · add to list')
  })
})

describe('createFormBody', () => {
  it('maps a full create input to snake_case, field list included', () => {
    const input: CreateFormInput = {
      name: 'Contact us',
      fields: [{ label: 'Work email', type: 'email', mapTo: 'person.email' }],
    }

    expect(createFormBody(input)).toEqual({
      name: 'Contact us',
      fields: [{ label: 'Work email', type: 'email', map_to: 'person.email' }],
    })
  })

  it('drops unset optional field properties without dropping the field itself', () => {
    const input: CreateFormInput = {
      name: 'Contact us',
      fields: [
        {
          label: 'How can we help?',
          type: 'textarea',
          mapTo: 'submission',
          required: true,
          placeholder: 'Tell us more',
          options: [{ key: 'k', value: 'v' }],
        },
      ],
    }

    expect(createFormBody(input).fields).toEqual([
      {
        label: 'How can we help?',
        type: 'textarea',
        map_to: 'submission',
        required: true,
        placeholder: 'Tell us more',
        options: [{ key: 'k', value: 'v' }],
      },
    ])
  })

  it('sends an Add to list field\'s lists and checkbox labels as snake_case', () => {
    const input: CreateFormInput = {
      name: 'Newsletter',
      fields: [
        {
          label: 'Add me to the mailing list',
          type: 'list',
          mapTo: 'lists',
          listIds: ['list_news'],
          listLabels: { list_news: 'Yes!' },
        },
      ],
    }

    expect(createFormBody(input).fields).toEqual([
      {
        label: 'Add me to the mailing list',
        type: 'list',
        map_to: 'lists',
        list_ids: ['list_news'],
        list_labels: { list_news: 'Yes!' },
      },
    ])
  })
})

describe('formBody', () => {
  it('sends only the fields that were set', () => {
    expect(formBody({ status: 'paused' })).toEqual({ status: 'paused' })
  })

  it('leaves fields untouched when not provided, so an update need not resend them', () => {
    const input: FormInput = { name: 'Renamed form' }

    expect(formBody(input)).toEqual({ name: 'Renamed form' })
  })

  it('sends an explicit null for dealStageId and dealNameTemplate as the clear-this signal', () => {
    expect(formBody({ dealStageId: null, dealNameTemplate: null })).toEqual({
      deal_stage_id: null,
      deal_name_template: null,
    })
  })
})

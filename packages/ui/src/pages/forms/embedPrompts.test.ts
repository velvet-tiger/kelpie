import type { FormField } from '@kelpie/schemas'
import { describe, expect, it } from 'vitest'

import { buildJsonSubmitPrompt } from './embedPrompts.ts'

const EMAIL_FIELD: FormField = {
  id: 'ff_email',
  label: 'Email',
  type: 'email',
  required: true,
  mapTo: 'person.email',
  options: [],
  placeholder: null,
  statement: null,
  consentPurposeIds: [],
  consentPurposeLabels: {},
  listIds: [],
  listLabels: {},
  sortOrder: 0,
}

const TOKEN_URL = 'https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/token'

function prompt(tokenUrl: string | null): string {
  return buildJsonSubmitPrompt({
    formName: 'Contact',
    submitUrl: 'https://kelpie.test/v1/public/workspaces/ws_1/forms/contact/submit',
    tokenUrl,
    fields: [EMAIL_FIELD],
    thankYouMessage: 'Thanks.',
    consentPurposes: new Map(),
    listNames: new Map(),
    workspaceName: 'Acme',
  })
}

describe('buildJsonSubmitPrompt', () => {
  it('says nothing about the spam check for a form that does not require it', () => {
    const text = prompt(null)

    expect(text).not.toContain('Spam check')
    expect(text).toContain('Do not add credentials, extra headers or extra keys to the request.')
  })

  it('gives the token steps for a form that requires the spam check', () => {
    const text = prompt(TOKEN_URL)

    expect(text).toContain('## Spam check')
    expect(text).toContain(`GET ${TOKEN_URL}`)
    expect(text).toContain('"token"')
    expect(text).toContain('"trap"')
    // The base rule would contradict the steps above it.
    expect(text).not.toContain('extra headers or extra keys')
  })
})

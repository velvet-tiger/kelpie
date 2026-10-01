import { describe, expect, it } from 'vitest'

import { embedContentSecurityPolicy, embedSnippets, escapeHtml, renderEmbedPage } from './embed.ts'
import type { FormFieldRecord, FormRecord } from './repository.ts'
import type { FormFieldMapTarget, FormFieldType, StoredFormFieldOption } from './schema.ts'

/**
 * The hosted embed page.
 *
 * A page built by string concatenation, carrying text a form author typed, and
 * served into somebody else's website. The escaping is the part worth pinning:
 * a label that closes a tag would be stored cross-site scripting against every
 * site that embeds the form.
 */

const stamp = new Date('2026-08-04T00:00:00.000Z')

interface FieldOverrides {
  readonly id?: string
  readonly label?: string
  readonly type?: FormFieldType
  readonly required?: boolean
  readonly placeholder?: string | null
  readonly options?: readonly StoredFormFieldOption[]
  readonly mapTo?: FormFieldMapTarget
}

function field(overrides: FieldOverrides = {}): FormFieldRecord {
  return {
    id: overrides.id ?? 'ff_email',
    workspaceId: 'ws_1',
    formId: 'form_1',
    label: overrides.label ?? 'Email',
    type: overrides.type ?? 'email',
    required: overrides.required ?? true,
    mapTo: overrides.mapTo ?? 'person.email',
    options: overrides.options ?? [],
    placeholder: overrides.placeholder ?? null,
    statement: null,
    consentPurposeIds: [],
    consentPurposeLabels: {},
    listIds: [],
    listLabels: {},
    sortOrder: 0,
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function form(overrides: Partial<FormRecord> = {}): FormRecord {
  return {
    id: 'form_1',
    workspaceId: 'ws_1',
    name: 'Website contact',
    title: 'Website contact',
    description: null,
    status: 'active',
    thankYouMessage: 'Thanks. We will be in touch.',
    createDeal: false,
    dealStageId: null,
    dealNameTemplate: null,
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
    notifyEmail: false,
    notifySubject: '',
    notifyBody: '',
    autoReply: false,
    autoReplySubject: '',
    autoReplyBody: '',
    autoReplyReplyToMemberId: null,
    autoReplyReplyToAddress: null,
    requireSpamCheck: false,
    slug: 'contact',
    createdAt: stamp,
    updatedAt: stamp,
    searchVector: null,
    ...overrides,
  }
}

const submitUrl = 'https://kelpie.test/v1/public/workspaces/ws_1/forms/contact/submit'

function render(
  overrides: Partial<FormRecord> = {},
  fields = [field()],
  layout: 'page' | 'embed' = 'page',
): string {
  return renderEmbedPage({
    form: form(overrides),
    fields,
    consentPurposes: new Map(),
    listNames: new Map(),
    submitUrl,
    nonce: 'n0nce',
    workspaceName: 'Acme Ventures',
    layout,
  })
}

describe('escapeHtml', () => {
  it('escapes everything that breaks out of element content or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('How can we help?')).toBe('How can we help?')
  })
})

describe('renderEmbedPage', () => {
  it('renders one control per field, labelled and named by its id', () => {
    const page = render({}, [
      field({ id: 'ff_name', label: 'Name', type: 'text', required: false }),
      field(),
    ])

    expect(page).toContain('<label for="ff_name">Name</label>')
    expect(page).toContain('id="ff_name" name="ff_name"')
    expect(page).toContain('type="email"')
  })

  it('renders a textarea rather than an input', () => {
    const page = render({}, [field({ id: 'ff_msg', label: 'Message', type: 'textarea' })])

    expect(page).toContain('<textarea id="ff_msg"')
  })

  it('renders a select over the option keys, with the label as the visible text', () => {
    const page = render({}, [
      field({
        id: 'ff_size',
        label: 'Team size',
        type: 'select',
        required: true,
        options: [{ key: 'small', value: '1-10', valueType: 'string' }],
      }),
    ])

    expect(page).toContain('<option value="small">1-10</option>')
  })

  /** An optional select needs a way back to "unanswered"; a required one does not. */
  it('gives an optional select a blank choice and a required one none', () => {
    const options = [{ key: 'small', value: '1-10', valueType: 'string' as const }]
    const optional = render({}, [field({ id: 'ff_a', type: 'select', required: false, options })])
    const required = render({}, [field({ id: 'ff_b', type: 'select', required: true, options })])

    expect(optional).toContain('<option value="">—</option>')
    expect(required).not.toContain('<option value="">—</option>')
  })

  it('escapes a label that tries to close its own tag', () => {
    const page = render({}, [field({ label: '</label><script>alert(1)</script>' })])

    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;/label&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes a placeholder that tries to break out of its attribute', () => {
    const page = render({}, [field({ placeholder: '" onfocus="alert(1)' })])

    expect(page).not.toContain('onfocus="alert(1)"')
    expect(page).toContain('placeholder="&quot; onfocus=&quot;alert(1)"')
  })

  it('escapes an option label', () => {
    const page = render({}, [
      field({
        id: 'ff_size',
        type: 'select',
        options: [{ key: 'a', value: '<img src=x onerror=alert(1)>', valueType: 'string' }],
      }),
    ])

    expect(page).not.toContain('<img src=x')
  })

  /**
   * The config block is JSON inside a `<script>`, and an HTML parser ends a
   * script at the literal `</script` wherever it appears, JSON string included.
   */
  it('keeps a thank-you message from closing the config script', () => {
    const page = render({ thankYouMessage: '</script><script>alert(1)</script>' })

    expect(page).not.toContain('</script><script>alert(1)')
    expect(page).toContain('\\u003c/script>')
  })

  it('carries the submit URL and the field ids the script posts', () => {
    const page = render({}, [field({ id: 'ff_email' }), field({ id: 'ff_name' })])

    expect(page).toContain(submitUrl)
    expect(page).toContain('"fieldIds":["ff_email","ff_name"]')
  })

  it('stamps the nonce on both inline tags, so the policy can name one source', () => {
    const page = render()

    expect(page).toContain('<style nonce="n0nce">')
    expect(page).toContain('<script nonce="n0nce">')
  })

  it('renders the form title and workspace name on the hosted page', () => {
    const page = render({
      name: 'Internal label',
      title: 'Talk to us',
      description: 'Say hello.',
    })

    expect(page).toContain('class="layout-page"')
    expect(page).toContain('<div class="eyebrow">Acme Ventures</div>')
    expect(page).toContain('<h1>Talk to us</h1>')
    expect(page).toContain('<title>Talk to us</title>')
    expect(page).not.toContain('<h1>Internal label</h1>')
    expect(page).toContain('<p class="lead">Say hello.</p>')
    expect(page).toContain('class="card"')
  })

  it('renders the iframe embed as fields only, without page chrome', () => {
    const page = render(
      { name: 'Internal label', title: 'Talk to us', description: 'Say hello.' },
      [field()],
      'embed',
    )

    expect(page).toContain('class="layout-embed"')
    expect(page).toContain('id="kelpie-form"')
    expect(page).toContain('background: Field')
    expect(page).not.toContain('--accent: #0f766e')
    expect(page).not.toContain('class="eyebrow"')
    expect(page).not.toContain('<h1>')
    expect(page).not.toContain('class="card"')
    expect(page).not.toContain('Say hello.')
  })

  it('keeps Kelpie tokens on the hosted page only', () => {
    const page = render({}, [field()], 'page')

    expect(page).toContain('--accent: #0f766e')
    expect(page).not.toContain('background: Field')
  })

  it('falls back to the form name when the title is blank', () => {
    const page = render({ name: 'Website contact', title: '   ' })

    expect(page).toContain('<h1>Website contact</h1>')
  })

  it('escapes the workspace name and form title in the visible heading', () => {
    const page = renderEmbedPage({
      form: form({ title: '<img src=x onerror=alert(1)>' }),
      fields: [field()],
      consentPurposes: new Map(),
    listNames: new Map(),
      submitUrl,
      nonce: 'n0nce',
      workspaceName: '<b>Acme</b>',
      layout: 'page',
    })

    expect(page).toContain('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>')
    expect(page).toContain('<div class="eyebrow">&lt;b&gt;Acme&lt;/b&gt;</div>')
    expect(page).not.toContain('<img src=x')
    expect(page).not.toContain('<b>Acme</b>')
  })

  /** Somebody visiting a page a site already embeds should be told, not shown a dead form. */
  it('renders a paused form as closed, with no form to submit', () => {
    const page = render({ status: 'paused' })

    expect(page).toContain('not accepting submissions')
    expect(page).not.toContain('<form')
    expect(page).toContain('<h1>Website contact</h1>')
  })

  it('renders a paused iframe embed without page chrome', () => {
    const page = render({ status: 'paused' }, [field()], 'embed')

    expect(page).toContain('not accepting submissions')
    expect(page).not.toContain('<form')
    expect(page).not.toContain('<h1>')
  })

  it('keeps itself out of search results', () => {
    expect(render()).toContain('<meta name="robots" content="noindex">')
  })
})

describe('embedContentSecurityPolicy', () => {
  it('allows only the nonced inline tags and the call back to this origin', () => {
    const policy = embedContentSecurityPolicy('n0nce')

    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'nonce-n0nce'")
    expect(policy).toContain("connect-src 'self'")
  })

  /** The page exists to be framed, which is why it must not also send X-Frame-Options. */
  it('permits framing from anywhere', () => {
    expect(embedContentSecurityPolicy('n0nce')).toContain('frame-ancestors *')
  })
})

describe('embedSnippets', () => {
  it('offers an iframe that needs no JavaScript, pointed at the bare embed URL', () => {
    const snippets = embedSnippets(
      'https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed?view=page',
      'https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed',
      'form_1',
    )

    expect(snippets.url).toContain('view=page')
    expect(snippets.embedUrl).toBe('https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed')
    expect(snippets.iframe).toContain('<iframe src="https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed"')
    expect(snippets.iframe).not.toContain('view=page')
    expect(snippets.iframe).not.toContain('<script')
  })

  it('offers a script that resizes the frame as the page grows', () => {
    const snippets = embedSnippets(
      'https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed?view=page',
      'https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed',
      'form_1',
    )

    expect(snippets.script).toContain("event.data.kelpie === 'height'")
    expect(snippets.script).toContain("event.data.formId === 'form_1'")
    expect(snippets.script).toContain('src="https://kelpie.test/v1/public/workspaces/ws_1/forms/form_1/embed"')
  })

  it('resizes only on messages from the embed origin', () => {
    const snippets = embedSnippets(
      'https://kelpie.test:8443/v1/public/workspaces/ws_1/forms/form_1/embed?view=page',
      'https://kelpie.test:8443/v1/public/workspaces/ws_1/forms/form_1/embed',
      'form_1',
    )

    expect(snippets.script).toContain("if (event.origin !== 'https://kelpie.test:8443') return;")
  })
})

describe('consent checkbox text', () => {
  const contactPurpose = {
    label: 'Contact',
    statement: 'I consent to {{workspace}} contacting me about my enquiry.',
  }

  function consentField(labels: Readonly<Record<string, string>> = {}): FormFieldRecord {
    return {
      ...field({ id: 'ff_consent', label: 'Consent', type: 'consent', required: false }),
      mapTo: 'person.consent',
      consentPurposeIds: ['cp_contact'],
      consentPurposeLabels: labels,
    }
  }

  function renderConsent(
    purposes: ReadonlyMap<string, { label: string; statement: string }>,
    labels: Readonly<Record<string, string>> = {},
    workspaceName = 'Acme Ventures',
  ): string {
    return renderEmbedPage({
      form: form(),
      fields: [consentField(labels)],
      consentPurposes: purposes,
      listNames: new Map(),
      submitUrl,
      nonce: 'n0nce',
      workspaceName,
      layout: 'embed',
    })
  }

  it('shows the purpose statement with the workspace name, not the label', () => {
    const html = renderConsent(new Map([['cp_contact', contactPurpose]]))

    expect(html).toContain(
      '<label for="ff_consent__0">I consent to Acme Ventures contacting me about my enquiry.</label>',
    )
    expect(html).not.toContain('{{workspace}}')
  })

  it('falls back to the label when the purpose has no statement', () => {
    const html = renderConsent(new Map([['cp_contact', { label: 'Contact', statement: '' }]]))

    expect(html).toContain('<label for="ff_consent__0">Contact</label>')
  })

  it("prefers the field's own override, and expands the token in it too", () => {
    const html = renderConsent(new Map([['cp_contact', contactPurpose]]), {
      cp_contact: 'Yes, {{workspace}} may call me.',
    })

    expect(html).toContain('<label for="ff_consent__0">Yes, Acme Ventures may call me.</label>')
  })

  it('escapes the workspace name after putting it in the statement', () => {
    const html = renderConsent(
      new Map([['cp_contact', contactPurpose]]),
      {},
      '<b>O\'Brien & Co</b>',
    )

    expect(html).toContain('I consent to &lt;b&gt;O&#39;Brien &amp; Co&lt;/b&gt; contacting me')
    expect(html).not.toContain('<b>O')
  })

  it('shows the purpose id when the purpose is gone and there is no override', () => {
    const html = renderConsent(new Map())

    expect(html).toContain('<label for="ff_consent__0">cp_contact</label>')
  })
})

describe('an Add to list field', () => {
  function listField(labels: Readonly<Record<string, string>> = {}): FormFieldRecord {
    return {
      ...field({ id: 'ff_lists', label: 'Add me to the mailing list', type: 'list', required: false }),
      mapTo: 'lists',
      statement: 'One email a month.',
      listIds: ['list_news', 'list_gone', 'list_events'],
      listLabels: labels,
    }
  }

  function renderLists(labels: Readonly<Record<string, string>> = {}): string {
    return renderEmbedPage({
      form: form(),
      fields: [field(), listField(labels)],
      consentPurposes: new Map(),
      listNames: new Map([
        ['list_news', 'Newsletter'],
        ['list_events', '<Events>'],
      ]),
      submitUrl,
      nonce: 'n0nce',
      workspaceName: 'Acme Ventures',
      layout: 'embed',
    })
  }

  it('shows the heading, the statement, and a box per list named by the list', () => {
    const html = renderLists()

    expect(html).toContain('<div class="field-label">Add me to the mailing list</div>')
    expect(html).toContain('<p class="list-statement">One email a month.</p>')
    expect(html).toContain(
      '<input type="checkbox" id="ff_lists__0" data-list-field="ff_lists" value="list_news">',
    )
    expect(html).toContain('<label for="ff_lists__0">Newsletter</label>')
    expect(html).toContain('<label for="ff_lists__1">&lt;Events&gt;</label>')
  })

  it("prefers the field's own checkbox text", () => {
    expect(renderLists({ list_news: 'Yes!' })).toContain('<label for="ff_lists__0">Yes!</label>')
  })

  it('leaves out a box for a list that no longer exists', () => {
    expect(renderLists()).not.toContain('list_gone')
  })

  it('leaves out the whole field when none of its lists exist', () => {
    const html = renderEmbedPage({
      form: form(),
      fields: [field(), listField()],
      consentPurposes: new Map(),
      listNames: new Map(),
      submitUrl,
      nonce: 'n0nce',
      workspaceName: 'Acme Ventures',
      layout: 'embed',
    })

    expect(html).not.toContain('Add me to the mailing list')
  })

  it('collects ticked list boxes into the answers like consent boxes', () => {
    expect(renderLists()).toContain('[data-list-field]')
  })
})

describe('a field with no label', () => {
  it('renders an input with no label element, named by its placeholder', () => {
    const html = render({}, [field({ label: '', placeholder: 'you@company.com' })])

    expect(html).not.toContain('<label for="ff_email">')
    expect(html).toContain('aria-label="you@company.com"')
  })

  it('renders a list field with no heading', () => {
    const html = renderEmbedPage({
      form: form(),
      fields: [
        field(),
        {
          ...field({ id: 'ff_lists', label: '', type: 'list', required: true }),
          mapTo: 'lists',
          listIds: ['list_news'],
          listLabels: { list_news: 'Tick here to get our monthly newsletter' },
        },
      ],
      consentPurposes: new Map(),
      listNames: new Map([['list_news', 'Newsletter']]),
      submitUrl,
      nonce: 'n0nce',
      workspaceName: 'Acme Ventures',
      layout: 'embed',
    })

    expect(html).toContain('<div class="field list"><div class="list-row">')
    expect(html).toContain('>Tick here to get our monthly newsletter</label>')
  })
})

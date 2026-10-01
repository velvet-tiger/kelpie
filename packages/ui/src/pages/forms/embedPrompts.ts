import { consentCheckboxText, formFieldDisplayLabel } from '@kelpie/schemas'
import type { ConsentPurpose, FormField } from '@kelpie/schemas'

/**
 * Prompts a person can paste into an AI coding assistant to put a form on their
 * site.
 *
 * Each prompt carries the exact URL or snippet from the API, so the assistant
 * has nothing to guess, and names the parts it must not change: the embed
 * address and the origin check in the resize listener.
 *
 * The JSON prompt is for a site that builds its own markup and posts to the
 * public submit endpoint. It also carries the form's fields as they are now,
 * with the ids the answers are keyed by and the exact text the embed shows
 * beside each consent and list checkbox.
 */

export interface EmbedPromptInput {
  /** The form's display name, for the assistant's context. */
  readonly formName: string
  readonly url: string
  readonly iframeSnippet: string
  readonly scriptSnippet: string
}

export interface EmbedPrompts {
  readonly hosted: string
  readonly iframe: string
  readonly script: string
}

export function buildEmbedPrompts({
  formName,
  url,
  iframeSnippet,
  scriptSnippet,
}: EmbedPromptInput): EmbedPrompts {
  return {
    hosted: [
      `I want to link to my "${formName}" form from my website. The form is hosted by Kelpie, a CRM, at this URL:`,
      '',
      url,
      '',
      'Please:',
      '1. Look at my site and suggest where a link or button to this form fits best (for example the navigation, footer, or a contact section). Ask me if it is not clear.',
      "2. Add the link using my site's existing components and styles for links or buttons.",
      '3. Use the URL exactly as given. Do not change or rebuild it.',
      '4. Decide with me whether it opens in the same tab or a new tab. If a new tab, add rel="noopener noreferrer".',
      '',
      'Do not rebuild the form yourself and do not send submissions anywhere else. The hosted page handles submission.',
    ].join('\n'),
    iframe: [
      `I want to embed my "${formName}" form on my website. The form is hosted by Kelpie, a CRM. This is the embed code:`,
      '',
      '```html',
      iframeSnippet,
      '```',
      '',
      'Please:',
      '1. Find the page where the form belongs. Ask me if it is not clear.',
      "2. Add the iframe in the way my site's framework expects (for example JSX attributes and a style object in React, or a component in Vue or Svelte).",
      '3. Keep the src URL exactly as given. Keep width 100% and no border. The height is fixed; change it only if the form is cut off or leaves a large gap.',
      "4. Place it inside my page's existing layout so it matches the content width.",
      '5. If my site sets a Content-Security-Policy, add the origin of the src URL to frame-src.',
      '',
      'Do not rebuild the form yourself and do not send submissions anywhere else. The iframe handles submission.',
    ].join('\n'),
    script: [
      `I want to embed my "${formName}" form on my website so that it resizes to fit its content. The form is hosted by Kelpie, a CRM. This is the embed code, an iframe and a script that listens for height messages from it:`,
      '',
      '```html',
      scriptSnippet,
      '```',
      '',
      'Please:',
      '1. Find the page where the form belongs. Ask me if it is not clear.',
      "2. Add the iframe and the listener in the way my site's framework expects. In a component framework such as React, Vue or Svelte, register the message listener when the component mounts and remove it when it unmounts, and use a ref for the iframe instead of getElementById.",
      '3. Keep the src URL exactly as given. Keep the origin check and the formId check in the listener exactly as given. They stop other pages from resizing the frame.',
      "4. Place it inside my page's existing layout so it matches the content width.",
      '5. If my site sets a Content-Security-Policy, add the origin of the src URL to frame-src, and allow the inline script or move it into a script file.',
      '',
      'Do not rebuild the form yourself and do not send submissions anywhere else. The iframe handles submission.',
    ].join('\n'),
  }
}

export interface JsonSubmitPromptInput {
  readonly formName: string
  readonly submitUrl: string
  /**
   * Where the site gets its spam-check token, when the form requires the check.
   * Null when it does not, and the prompt then says nothing about the check.
   */
  readonly tokenUrl: string | null
  readonly fields: readonly FormField[]
  readonly thankYouMessage: string
  /** Workspace consent purposes by id, for the checkbox text a consent field shows. */
  readonly consentPurposes: ReadonlyMap<string, Pick<ConsentPurpose, 'label' | 'statement'>>
  /** List names by id, for the checkbox text an "Add to list" field shows. */
  readonly listNames: ReadonlyMap<string, string>
  readonly workspaceName: string
}

export function buildJsonSubmitPrompt({
  formName,
  submitUrl,
  tokenUrl,
  fields,
  thankYouMessage,
  consentPurposes,
  listNames,
  workspaceName,
}: JsonSubmitPromptInput): string {
  const ordered = [...fields].sort((left, right) => left.sortOrder - right.sortOrder)
  const describe = (field: FormField): string =>
    describeField(field, consentPurposes, listNames, workspaceName)
  const example = Object.fromEntries(
    ordered
      .filter((field) => field.type !== 'notice')
      .map((field): [string, string] => [field.id, exampleAnswer(field)]),
  )

  return [
    `I want to build my own form on my website that sends its answers to my "${formName}" form in Kelpie, a CRM, as JSON.`,
    '',
    '## Endpoint',
    '',
    `POST ${submitUrl}`,
    'Content-Type: application/json',
    '',
    'Send no API key, cookie or other credential. The endpoint accepts requests from any origin, so the browser can call it directly.',
    '',
    '## Request body',
    '',
    '```json',
    JSON.stringify({ answers: example }, null, 2),
    '```',
    '',
    'The values above are examples. Rules for `answers`:',
    '- The keys are the field ids below. An unknown key makes the request fail.',
    '- Every value is a string.',
    '- If the visitor gives no answer, leave the key out. A required field must have a value.',
    '- Select: send the option key, not the text the visitor sees.',
    '- Consent and "Add to list": send the ids of the ticked boxes as one comma-separated string, for example "id1,id2". Show the statement and the checkbox text exactly as given below.',
    '- Notice: show the text. Send no answer for it.',
    '',
    '## Fields, in display order',
    '',
    ...ordered.map(describe),
    '',
    ...(tokenUrl === null ? [] : spamCheckSection(tokenUrl)),
    '## Responses',
    '',
    '- 201: `{ "id", "form_id", "submitted_at", "thank_you_message" }`. Replace the form with `thank_you_message`.' +
      (thankYouMessage.trim().length > 0 ? ` It is currently: "${thankYouMessage}"` : ''),
    '- 422 `validation_failed`: `{ "error": { "code", "message", "details": [{ "field": "answers.<field id>", "message" }] } }`. Show each detail message next to its field, and `error.message` above the form.',
    '- 404 (form not found), 409 (form paused) and 429 (too many requests): `{ "error": { "code", "message" } }`. Show `error.message`.',
    '',
    '## Please',
    '',
    '1. Find the page where the form belongs. Ask me if it is not clear.',
    "2. Build the form with my site's existing components and styles: one input for each field above, in the order given. Use an email input for email fields, a textarea for textarea fields, a select for select fields, and checkboxes for consent and \"Add to list\" fields.",
    "3. Submit with fetch or my framework's usual data layer. Disable the submit button while the request is pending, and show the responses as described above.",
    '4. Keep the endpoint URL exactly as given. If my site sets a Content-Security-Policy, add the origin of the endpoint to connect-src.',
    tokenUrl === null
      ? '5. Do not add credentials, extra headers or extra keys to the request.'
      : '5. Do not add credentials or extra headers to the request. The only keys in the body are `answers`, `token` and `trap`.',
    '',
    'The endpoint URL contains the form\'s slug. If the slug changes in Kelpie, the URL changes. If fields change in Kelpie, this field list changes. In both cases, copy a new prompt from Kelpie.',
  ].join('\n')
}

/**
 * What a site's own form must do for a form that requires the spam check.
 * Without it Kelpie holds every submission as spam, and the response does not
 * say so, which is why the prompt says it plainly.
 */
function spamCheckSection(tokenUrl: string): readonly string[] {
  return [
    '## Spam check',
    '',
    'This form requires a spam check. If the request does not pass it, Kelpie still answers 201, but it holds the submission as spam and my team does not see it as a lead. Do all three steps.',
    '',
    `1. When the page that shows the form loads, send \`GET ${tokenUrl}\` with no credentials. The response is \`{ "token": "…" }\`. Keep the token. Do not get it at submit time: Kelpie holds a submit that arrives less than a few seconds after its token was issued. A token is good for 24 hours.`,
    '2. Add `"token": "<the token>"` to the request body, beside `answers`.',
    '3. Add one extra text input to the form that people cannot see or reach: move it off screen with CSS (do not use `display: none`), and give it `tabindex="-1"`, `autocomplete="off"` and `aria-hidden="true"` on its wrapper. If it has a value at submit time, add `"trap": "<its value>"` to the request body. A person leaves it empty, so leave the key out.',
    '',
    'If my Kelpie uses a CAPTCHA provider, my own form cannot pass the check. Tell me to use the Kelpie iframe embed instead.',
    '',
  ]
}

function describeField(
  field: FormField,
  consentPurposes: ReadonlyMap<string, Pick<ConsentPurpose, 'label' | 'statement'>>,
  listNames: ReadonlyMap<string, string>,
  workspaceName: string,
): string {
  const label = field.label.trim()
  const heading = label.length > 0 ? `"${label}"` : `no visible label (holds ${formFieldDisplayLabel(field)})`
  const lines = [`- \`${field.id}\`: ${heading}. Type ${field.type}, ${field.required ? 'required' : 'optional'}.`]

  if (field.placeholder !== null && field.placeholder.trim().length > 0) {
    lines.push(`  Placeholder: "${field.placeholder}"`)
  }

  if (field.type === 'select') {
    lines.push('  Options (key: text shown):')
    lines.push(...field.options.map((option) => `  - \`${option.key}\`: "${option.value}"`))
  }

  if (field.type === 'notice') {
    lines.push(`  Text: "${field.statement ?? ''}"`)
  }

  if (field.type === 'consent') {
    lines.push(`  Statement: "${field.statement ?? field.label}"`)
    lines.push('  Checkboxes (id: text shown):')
    lines.push(
      ...field.consentPurposeIds.map((id) => {
        const purpose = consentPurposes.get(id) ?? { label: id, statement: '' }
        const text = consentCheckboxText(field.consentPurposeLabels[id], purpose, workspaceName)
        return `  - \`${id}\`: "${text}"`
      }),
    )
  }

  if (field.type === 'list') {
    const statement = (field.statement ?? '').trim()
    if (statement.length > 0) {
      lines.push(`  Statement: "${statement}"`)
    }
    lines.push('  Checkboxes (id: text shown):')
    lines.push(
      ...field.listIds.map((id) => `  - \`${id}\`: "${field.listLabels[id] ?? listNames.get(id) ?? id}"`),
    )
  }

  return lines.join('\n')
}

function exampleAnswer(field: FormField): string {
  switch (field.type) {
    case 'email':
      return 'jane@example.com'
    case 'select':
      return field.options[0]?.key ?? ''
    case 'consent':
      return field.consentPurposeIds.join(',')
    case 'list':
      return field.listIds.join(',')
    case 'textarea':
      return 'A longer answer.'
    default:
      return 'Example'
  }
}

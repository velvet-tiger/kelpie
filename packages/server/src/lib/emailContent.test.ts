import { describe, expect, it } from 'vitest'

import { renderEmail, renderTextEmail } from './emailContent.ts'

const APP_BASE_URL = 'https://crm.example.com'
const LINK = 'https://crm.example.com/verify-email?token=abc123_-xyz'

/** The text of the header link: the first link in the mail. */
function headerNameOf(html: string): string | undefined {
  return /<a [^>]*>\s*([^<]*?)\s*<\/a>/u.exec(html)?.[1]
}

describe('renderEmail', () => {
  it('builds the plaintext part as instructions, link, then outro', () => {
    const { text } = renderEmail(
      {
        action: {
          instructions: 'Confirm this address to finish setting up your account:',
          buttonText: 'Verify email address',
          link: LINK,
        },
        outro: 'The link expires in 24 hours.',
      },
      APP_BASE_URL,
    )

    expect(text).toBe(
      `Confirm this address to finish setting up your account:\n\n${LINK}\n\nThe link expires in 24 hours.`,
    )
  })

  it('builds an intro-only message with no link', () => {
    const { text, html } = renderEmail(
      { intro: 'Your sign-in email changed. If you did not make this change, reset your password.' },
      APP_BASE_URL,
    )

    expect(text).toBe('Your sign-in email changed. If you did not make this change, reset your password.')
    expect(html).toContain('Your sign-in email changed.')
    expect(html).not.toContain('btn-primary')
  })

  it('renders the action as a button plus the raw link as a fallback', () => {
    // The raw link matters: a client that strips or ignores the button styling
    // still has to leave the reader a way through.
    const { html } = renderEmail(
      {
        action: { instructions: 'Use this link:', buttonText: 'Reset password', link: LINK },
      },
      APP_BASE_URL,
    )

    expect(html).toContain('Reset password')
    expect(html).toContain(LINK)
    expect(html).toContain('<table')
  })

  it('omits the greeting and signature: transactional mail is not a letter', () => {
    const { html } = renderEmail({ intro: 'A bare message.' }, APP_BASE_URL)

    expect(html).not.toContain('Yours truly')
    expect(html).not.toContain('Hi ')
  })

  it('links the header to the deployment and keeps the footer fixed', () => {
    const { html } = renderEmail({ intro: 'A bare message.' }, APP_BASE_URL)

    expect(html).toContain(APP_BASE_URL)
    expect(html).toContain('Sent by Kelpie.')
  })

  it('names Kelpie in the header unless the caller gives a name', () => {
    const content = { intro: 'A bare message.' }

    expect(headerNameOf(renderEmail(content, APP_BASE_URL).html)).toBe('Kelpie')
    expect(headerNameOf(renderEmail(content, APP_BASE_URL, 'Acme').html)).toBe('Acme')
  })

  it('shows the header name as text, with no link, when the reader is outside the workspace', () => {
    const { html, text } = renderEmail({ intro: 'A bare message.' }, APP_BASE_URL, 'Acme', 'none')

    expect(html).not.toContain(APP_BASE_URL)
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
    // The name keeps the class and the inline style the link had.
    expect(html).toMatch(/<span class="email-masthead_name" style="[^"]+">\s*Acme\s*<\/span>/u)
    expect(html).toContain('Sent by Kelpie.')
    expect(text).toBe('A bare message.')
  })

  it('removes only the header link: the action keeps its links', () => {
    const content = { action: { instructions: 'Use this link:', buttonText: 'Open', link: LINK } }
    const linked = renderEmail(content, APP_BASE_URL, 'Acme').html
    const { html } = renderEmail(content, APP_BASE_URL, 'Acme', 'none')
    const anchorsIn = (rendered: string): number => rendered.split('<a ').length - 1

    expect(html).not.toContain(`href="${APP_BASE_URL}"`)
    expect(html).toContain(`href="${LINK}"`)
    expect(anchorsIn(html)).toBe(anchorsIn(linked) - 1)
  })

  it('links the header when the caller does not say', () => {
    const { html } = renderEmail({ intro: 'A bare message.' }, APP_BASE_URL, 'Acme')

    expect(html).toMatch(new RegExp(`<a class="email-masthead_name" href="${APP_BASE_URL}"[^>]*>\\s*Acme\\s*</a>`, 'u'))
  })

  it('is deterministic: the same content renders the same bytes', () => {
    // The default mailgen footer stamps the current year; the fixed copyright
    // line replaces it. Byte-equality catches any nondeterminism creeping back.
    const content = { intro: 'A bare message.' }

    expect(renderEmail(content, APP_BASE_URL)).toEqual(renderEmail(content, APP_BASE_URL))
  })
})

describe('renderTextEmail', () => {
  const content = {
    intro: 'Message: <script>alert(1)</script>\nName: "Alex" & <b>Co</b>',
    action: {
      instructions: 'Open the submission in Kelpie.',
      buttonText: 'View submission',
      link: 'https://kelpie.test/forms/form_1/submissions/sub_1',
    },
  }

  it('keeps the plaintext part exactly as given', () => {
    const rendered = renderTextEmail(content, 'https://kelpie.test')

    expect(rendered.text).toBe(
      'Message: <script>alert(1)</script>\nName: "Alex" & <b>Co</b>\n\n' +
        'Open the submission in Kelpie.\n\nhttps://kelpie.test/forms/form_1/submissions/sub_1',
    )
  })

  it('escapes every value in the HTML part and keeps line breaks', () => {
    const { html } = renderTextEmail(content, 'https://kelpie.test')

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>Co</b>')
    expect(html).toContain('Message: &lt;script&gt;alert(1)&lt;/script&gt;<br>Name: &quot;Alex&quot; &amp; &lt;b&gt;Co&lt;/b&gt;')
  })

  it('escapes the header name', () => {
    const { html } = renderTextEmail(content, 'https://kelpie.test', 'Acme <b>& Co</b>')

    expect(html).not.toContain('<b>& Co</b>')
    expect(headerNameOf(html)).toBe('Acme &lt;b&gt;&amp; Co&lt;/b&gt;')
  })

  it('escapes the header name when it has no link, and keeps a "$" in it', () => {
    const { html } = renderTextEmail(content, 'https://kelpie.test', 'Acme <b>$1 & Co</b>', 'none')

    expect(html).not.toContain('<b>$1 & Co</b>')
    expect(html).toMatch(/<span class="email-masthead_name"[^>]*>\s*Acme &lt;b&gt;\$1 &amp; Co&lt;\/b&gt;\s*<\/span>/u)
    expect(html).not.toContain('href="https://kelpie.test"')
  })
})

describe('the package index', () => {
  it('exports the renderer, so an assembly can build mail that looks like core mail', async () => {
    const index = await import('../index.ts')

    expect(index.renderEmail).toBe(renderEmail)
    expect(index.renderTextEmail).toBe(renderTextEmail)
  })
})

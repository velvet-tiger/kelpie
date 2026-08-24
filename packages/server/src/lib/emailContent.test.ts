import { describe, expect, it } from 'vitest'

import { renderEmail } from './emailContent.ts'

const APP_BASE_URL = 'https://crm.example.com'
const LINK = 'https://crm.example.com/verify-email?token=abc123_-xyz'

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

  it('is deterministic: the same content renders the same bytes', () => {
    // The default mailgen footer stamps the current year; the fixed copyright
    // line replaces it. Byte-equality catches any nondeterminism creeping back.
    const content = { intro: 'A bare message.' }

    expect(renderEmail(content, APP_BASE_URL)).toEqual(renderEmail(content, APP_BASE_URL))
  })
})

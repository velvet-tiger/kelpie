import Mailgen from 'mailgen'

/**
 * Renders transactional mail bodies: a plaintext part and an HTML part from
 * one description of the message.
 *
 * Email clients need table-based, inline-styled HTML; mailgen owns that
 * problem so Kelpie does not. The plaintext part is built here by hand rather
 * than by mailgen's plaintext generator, because that generator pads lines
 * with trailing whitespace and the plaintext body is the part tests and
 * text-only clients read token links out of. The wording of the two parts
 * comes from the same fields, so they cannot drift.
 */

/** A link the message asks the reader to follow, rendered as a button in HTML. */
export interface EmailAction {
  readonly instructions: string
  readonly buttonText: string
  readonly link: string
}

export interface EmailContent {
  readonly intro?: string
  readonly action?: EmailAction
  readonly outro?: string
}

export interface RenderedEmail {
  readonly text: string
  readonly html: string
}

/**
 * Fixed so rendering is deterministic. Mailgen's default footer stamps the
 * current year, which the sender has no claim to: the workspace, not Kelpie,
 * owns the relationship with the recipient.
 */
const FOOTER_LINE = 'Sent by Kelpie.'

/**
 * Renders one transactional message. `appBaseUrl` becomes the link on the
 * product name in the header and footer, so every part of the mail points at
 * the deployment that sent it.
 */
export function renderEmail(content: EmailContent, appBaseUrl: string): RenderedEmail {
  const generator = new Mailgen({
    theme: 'default',
    product: {
      name: 'Kelpie',
      link: appBaseUrl,
      copyright: FOOTER_LINE,
    },
  })

  const html: string = generator.generate({
    body: {
      greeting: false,
      signature: false,
      ...(content.intro === undefined ? {} : { intro: content.intro }),
      ...(content.action === undefined
        ? {}
        : {
            action: {
              instructions: content.action.instructions,
              button: {
                text: content.action.buttonText,
                link: content.action.link,
                fallback: true,
              },
            },
          }),
      ...(content.outro === undefined ? {} : { outro: content.outro }),
    },
  })

  return { text: plainTextOf(content), html }
}

function plainTextOf(content: EmailContent): string {
  const paragraphs: string[] = []

  if (content.intro !== undefined) {
    paragraphs.push(content.intro)
  }

  if (content.action !== undefined) {
    paragraphs.push(`${content.action.instructions}\n\n${content.action.link}`)
  }

  if (content.outro !== undefined) {
    paragraphs.push(content.outro)
  }

  return paragraphs.join('\n\n')
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for HTML, and keeps its line breaks as `<br>`. */
function htmlFromText(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character).replace(/\r?\n/gu, '<br>')
}

/**
 * Renders a message whose words Kelpie did not write: a form email, whose
 * template an admin wrote and whose values a visitor typed.
 *
 * `renderEmail` hands its strings to mailgen, and mailgen puts them into the
 * HTML part unescaped (`<%- %>`), which is right for Kelpie's own fixed copy
 * and wrong for anything else: an answer holding markup would become markup.
 * Here every string is escaped for the HTML part and its line breaks kept.
 * The plaintext part is the text exactly as given.
 */
export function renderTextEmail(content: EmailContent, appBaseUrl: string): RenderedEmail {
  const escaped: EmailContent = {
    ...(content.intro === undefined ? {} : { intro: htmlFromText(content.intro) }),
    ...(content.action === undefined
      ? {}
      : {
          action: {
            instructions: htmlFromText(content.action.instructions),
            buttonText: htmlFromText(content.action.buttonText),
            link: htmlFromText(content.action.link),
          },
        }),
    ...(content.outro === undefined ? {} : { outro: htmlFromText(content.outro) }),
  }

  return { text: plainTextOf(content), html: renderEmail(escaped, appBaseUrl).html }
}

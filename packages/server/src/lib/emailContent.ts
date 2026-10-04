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

/** The name in the header when the caller gives none. */
const DEFAULT_HEADER_NAME = 'Kelpie'

/**
 * Where the name in the header goes when the reader selects it.
 *
 * `'deployment'` links it to the deployment that sent the mail. That is for a
 * reader who can sign in there: a member, or a person who was invited.
 * `'none'` shows the name as text. That is for a reader outside the workspace,
 * such as the person who submitted a form: the deployment's address gives
 * that reader only a sign-in page.
 */
export type EmailHeaderLink = 'deployment' | 'none'

/**
 * The header link as mailgen's default theme writes it, after its styles are
 * put inline: one anchor with the class `email-masthead_name`. The groups are
 * the attributes before `href`, the attributes after `target`, and the name.
 */
const HEADER_ANCHOR =
  /<a(\s+class="email-masthead_name")\s+href="[^"]*"\s+target="_blank"(\s+style="[^"]*")?\s*>([\s\S]*?)<\/a>/u

/**
 * Replaces the header anchor with a `span` that has the same class, style and
 * content. mailgen has no option for a header without a link (it refuses a
 * product with no `link`, and its theme always writes the anchor), so the
 * anchor is removed from the rendered HTML.
 *
 * @throws Error when the HTML has no header anchor in the expected form. A
 * mailgen release that changes the header must stop the send here, not let
 * the link back in without a sign.
 */
function withoutHeaderLink(html: string): string {
  if (!HEADER_ANCHOR.test(html)) {
    throw new Error('the email header link was not found in the HTML that mailgen rendered')
  }

  return html.replace(
    HEADER_ANCHOR,
    (_anchor, classAttribute: string, styleAttribute: string | undefined, name: string) =>
      `<span${classAttribute}${styleAttribute ?? ''}>${name}</span>`,
  )
}

/**
 * Renders one transactional message. `appBaseUrl` becomes the link on the
 * name in the header and footer, so every part of the mail points at the
 * deployment that sent it. `headerName` is the name in the header: Kelpie's,
 * unless the mail speaks for a workspace. It goes into the HTML unescaped.
 */
export function renderEmail(
  content: EmailContent,
  appBaseUrl: string,
  headerName: string = DEFAULT_HEADER_NAME,
  headerLink: EmailHeaderLink = 'deployment',
): RenderedEmail {
  const generator = new Mailgen({
    theme: 'default',
    product: {
      name: headerName,
      // mailgen needs a link here. For `'none'` it is taken out again below.
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

  return { text: plainTextOf(content), html: headerLink === 'none' ? withoutHeaderLink(html) : html }
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
 * The plaintext part is the text exactly as given. `headerName` is escaped the
 * same way: a workspace name is also text an admin typed.
 */
export function renderTextEmail(
  content: EmailContent,
  appBaseUrl: string,
  headerName: string = DEFAULT_HEADER_NAME,
  headerLink: EmailHeaderLink = 'deployment',
): RenderedEmail {
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

  return {
    text: plainTextOf(content),
    html: renderEmail(escaped, appBaseUrl, htmlFromText(headerName), headerLink).html,
  }
}

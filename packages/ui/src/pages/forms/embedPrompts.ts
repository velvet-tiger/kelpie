/**
 * Prompts a person can paste into an AI coding assistant to put a form on their
 * site.
 *
 * Each prompt carries the exact URL or snippet from the API, so the assistant
 * has nothing to guess, and names the parts it must not change: the embed
 * address and the origin check in the resize listener.
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

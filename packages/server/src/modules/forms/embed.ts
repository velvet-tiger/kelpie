import type { FormFieldRecord, FormRecord } from './repository.ts'

/**
 * The hosted embed page and the snippets that put it on a customer's site.
 *
 * Server-rendered and self-contained on purpose. A site embedding a Kelpie form
 * frames a page from the Kelpie origin, and that page must not drag the CRM's
 * React bundle into somebody else's marketing site to draw five inputs.
 *
 * Everything here is pure: a form, its fields, and a URL in; a string out. That
 * is what makes the escaping testable, which for a page built by string
 * concatenation is the part worth testing.
 */

/** `'` as `&#39;` rather than `&apos;`, which older HTML parsers do not know. */
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes text for both element content and quoted attribute values.
 *
 * Every value a form author typed reaches this page, so a label of
 * `"><script>…` would otherwise be a stored cross-site scripting hole against
 * whoever embeds the form. One function for both positions because the set of
 * characters that break out of either is the same.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/gu, (match) => HTML_ESCAPES[match] ?? match)
}

/**
 * Escapes a string for a `<script>` body.
 *
 * An HTML parser ends a script at the literal `</script`, wherever it appears,
 * including inside a JSON string. Breaking the sequence is what keeps embedded
 * data from closing the element that carries it.
 */
function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

function renderOptions(field: FormFieldRecord): string {
  const blank = field.required ? '' : '<option value="">—</option>'
  const choices = field.options
    .map((option) => `<option value="${escapeHtml(option.key)}">${escapeHtml(option.value)}</option>`)
    .join('')

  return blank + choices
}

function renderControl(field: FormFieldRecord): string {
  const shared = [
    `id="${escapeHtml(field.id)}"`,
    `name="${escapeHtml(field.id)}"`,
    ...(field.required ? ['required'] : []),
    ...(field.placeholder === null ? [] : [`placeholder="${escapeHtml(field.placeholder)}"`]),
  ].join(' ')

  if (field.type === 'select') {
    return `<select ${shared}>${renderOptions(field)}</select>`
  }

  if (field.type === 'textarea') {
    return `<textarea ${shared} rows="4"></textarea>`
  }

  // `type="email"` gives a phone keyboard the @ key and catches a typo before a
  // round trip. The server validates the address regardless.
  return `<input ${shared} type="${field.type === 'email' ? 'email' : 'text'}">`
}

function renderField(field: FormFieldRecord): string {
  const required = field.required ? '<span class="req" aria-hidden="true">*</span>' : ''

  return [
    '<div class="field">',
    `<label for="${escapeHtml(field.id)}">${escapeHtml(field.label)}${required}</label>`,
    renderControl(field),
    '</div>',
  ].join('')
}

/**
 * Styles for the page. Deliberately plain and system-font: this renders inside
 * somebody else's design, and a form that tries to bring its own brand fights
 * the site it was embedded in.
 */
const EMBED_STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
form { display: grid; gap: 14px; max-width: 32rem; margin: 0 auto; }
.field { display: grid; gap: 5px; }
label { font-weight: 600; font-size: 0.875rem; }
.req { color: #b4232c; margin-left: 2px; }
input, textarea, select { width: 100%; padding: 9px 10px; border: 1px solid #b9bfc9; border-radius: 6px; font: inherit; background: Field; color: FieldText; }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #2f6feb; outline-offset: 1px; }
textarea { resize: vertical; }
button { padding: 10px 16px; border: 0; border-radius: 6px; background: #2f6feb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button[disabled] { opacity: 0.6; cursor: progress; }
.note { margin: 0; font-size: 0.875rem; }
.error { color: #b4232c; }
.done { max-width: 32rem; margin: 0 auto; }
`

/**
 * The browser half of the page.
 *
 * Plain `fetch` and no dependencies, so the page loads nothing from anywhere and
 * a strict Content-Security-Policy can refuse every external origin. The height
 * is posted to the parent because an iframe cannot size itself; the companion
 * listener ships in `scriptSnippet`.
 */
const EMBED_SCRIPT = `
(function () {
  var config = JSON.parse(document.getElementById('kelpie-config').textContent);
  var form = document.getElementById('kelpie-form');
  var status = document.getElementById('kelpie-status');
  var button = document.getElementById('kelpie-submit');

  function postHeight() {
    parent.postMessage({ kelpie: 'height', formId: config.formId, height: document.documentElement.scrollHeight }, '*');
  }

  new ResizeObserver(postHeight).observe(document.documentElement);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    status.textContent = '';
    status.className = 'note';
    button.disabled = true;

    var answers = {};
    config.fieldIds.forEach(function (id) {
      var value = form.elements[id].value.trim();
      if (value) { answers[id] = value; }
    });

    fetch(config.submitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: answers })
    }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; });
    }).then(function (result) {
      if (!result.ok) {
        throw new Error((result.body && result.body.error && result.body.error.message) || 'Something went wrong.');
      }
      var done = document.createElement('div');
      done.className = 'done';
      done.textContent = result.body.thank_you_message || config.thankYou;
      form.replaceWith(done);
      parent.postMessage({ kelpie: 'submitted', formId: config.formId }, '*');
      postHeight();
    }).catch(function (error) {
      status.textContent = error.message;
      status.className = 'note error';
      button.disabled = false;
    });
  });
})();
`

export interface EmbedPageOptions {
  readonly form: FormRecord
  readonly fields: readonly FormFieldRecord[]
  /** Absolute URL of the public submit endpoint this page posts to. */
  readonly submitUrl: string
  /** Per-response value tying the inline style and script to the CSP header. */
  readonly nonce: string
}

/**
 * The whole page, as one document.
 *
 * A paused form still renders. Somebody visiting the page a customer's site
 * already embeds should be told the form is closed rather than shown a working
 * form whose submit answers 409.
 */
export function renderEmbedPage(options: EmbedPageOptions): string {
  const { form, fields, submitUrl, nonce } = options
  const config = escapeScriptJson({
    formId: form.id,
    submitUrl,
    thankYou: form.thankYouMessage,
    fieldIds: fields.map((field) => field.id),
  })
  const body =
    form.status === 'paused'
      ? `<div class="done"><p class="note">This form is not accepting submissions right now.</p></div>`
      : [
          '<form id="kelpie-form" novalidate>',
          fields.map(renderField).join(''),
          '<div><button id="kelpie-submit" type="submit">Submit</button></div>',
          '<p id="kelpie-status" class="note" role="status" aria-live="polite"></p>',
          '</form>',
          `<script type="application/json" id="kelpie-config">${config}</script>`,
          `<script nonce="${escapeHtml(nonce)}">${EMBED_SCRIPT}</script>`,
        ].join('')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Not indexed: the canonical page for this form is the customer's own, and
    // a bare embed ranking above it would be a worse result for a reader.
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(form.name)}</title>`,
    `<style nonce="${escapeHtml(nonce)}">${EMBED_STYLES}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('')
}

/**
 * The page's Content-Security-Policy.
 *
 * `default-src 'none'` because the page loads nothing: no fonts, no images, no
 * scripts from anywhere. `connect-src 'self'` allows the one `fetch` back to the
 * submit endpoint. `frame-ancestors *` is the point of the page and is why it
 * must not also send `X-Frame-Options`.
 */
export function embedContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'none'",
    'frame-ancestors *',
  ].join('; ')
}

/** What a customer pastes into their site. Both put the same hosted page on the page. */
export interface EmbedSnippets {
  readonly url: string
  readonly iframe: string
  readonly script: string
}

/**
 * The two ways to embed.
 *
 * The iframe is the honest minimum: one tag, no JavaScript, fixed height. The
 * script adds the listener that resizes it as fields appear and as the thank-you
 * replaces the form, which is the only thing an iframe cannot do for itself.
 */
export function embedSnippets(url: string, formId: string): EmbedSnippets {
  const iframe =
    `<iframe src="${escapeHtml(url)}" title="Contact form" ` +
    `style="width:100%;border:0;height:520px" loading="lazy"></iframe>`

  const script = [
    `<iframe id="kelpie-${formId}" src="${escapeHtml(url)}" title="Contact form"`,
    `        style="width:100%;border:0;height:520px" loading="lazy"></iframe>`,
    `<script>`,
    `  window.addEventListener('message', function (event) {`,
    `    if (event.data && event.data.kelpie === 'height' && event.data.formId === '${formId}') {`,
    `      document.getElementById('kelpie-${formId}').style.height = event.data.height + 'px';`,
    `    }`,
    `  });`,
    `</script>`,
  ].join('\n')

  return { url, iframe, script }
}

import type { FormFieldRecord, FormRecord } from './repository.ts'

/**
 * The hosted embed page and the snippets that put it on a customer's site.
 *
 * Server-rendered and self-contained on purpose. A site embedding a Kelpie form
 * frames a page from the Kelpie origin, and that page must not drag the CRM's
 * React bundle into somebody else's marketing site to draw five inputs.
 *
 * The hosted layout carries Kelpie's look. The iframe layout is intentionally
 * unbranded (system font, Field colours) so it does not paint Kelpie onto the
 * host site — an iframe cannot inherit the host's CSS, so staying neutral is
 * the alternative.
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

function renderField(
  field: FormFieldRecord,
  consentPurposeLabels: ReadonlyMap<string, string>,
): string {
  const required = field.required ? '<span class="req" aria-hidden="true">*</span>' : ''

  if (field.type === 'notice') {
    // Text-only: prose the visitor reads before submitting. Submission is the
    // consent (see readConsentGrants), so no input is rendered. `label` is
    // the heading; `statement` is the prose.
    const statement = field.statement ?? ''
    return [
      '<div class="field notice">',
      `<div class="field-label">${escapeHtml(field.label)}</div>`,
      `<p class="notice-body">${escapeHtml(statement)}</p>`,
      '</div>',
    ].join('')
  }

  if (field.type === 'consent') {
    // Layout: the field label above (heading, e.g. "Consent"), the intro
    // statement, then one checkbox per configured purpose. The submit reads
    // the ticked checkboxes' values (purpose ids) from EMBED_SCRIPT and
    // sends them as a comma-separated string under the field id.
    const statement = field.statement ?? field.label
    const rows = field.consentPurposeIds
      .map((purposeId, index) => {
        const boxId = `${field.id}__${String(index)}`
        // Field-level override wins over the workspace's default label. Falls
        // back to the workspace label, then the raw id — the id only shows up
        // when a purpose has been deleted and its label was never overridden.
        const override = field.consentPurposeLabels[purposeId]
        const label = override ?? consentPurposeLabels.get(purposeId) ?? purposeId
        return [
          '<div class="consent-row">',
          `<input type="checkbox" id="${escapeHtml(boxId)}" data-consent-field="${escapeHtml(field.id)}" value="${escapeHtml(purposeId)}">`,
          `<label for="${escapeHtml(boxId)}">${escapeHtml(label)}</label>`,
          '</div>',
        ].join('')
      })
      .join('')
    return [
      '<div class="field consent">',
      `<div class="field-label">${escapeHtml(field.label)}${required}</div>`,
      `<p class="consent-statement">${escapeHtml(statement)}</p>`,
      rows,
      '</div>',
    ].join('')
  }

  return [
    '<div class="field">',
    `<label for="${escapeHtml(field.id)}">${escapeHtml(field.label)}${required}</label>`,
    renderControl(field),
    '</div>',
  ].join('')
}

/**
 * Styles for the standalone hosted page — Kelpie tokens, brand chrome, card.
 */
const HOSTED_STYLES = `
:root {
  color-scheme: light;
  --surface: #fafafa;
  --surface-raised: #ffffff;
  --ink: #18181b;
  --ink-muted: #52525b;
  --ink-faint: #71717a;
  --border: #e4e4e7;
  --accent: #0f766e;
  --accent-hover: #0d9488;
  --accent-soft: #f0fdfa;
  --accent-fg: #ffffff;
  --danger: #dc2626;
  --font: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #0c0c0d;
    --surface-raised: #141416;
    --ink: #fafafa;
    --ink-muted: #a1a1aa;
    --ink-faint: #71717a;
    --border: #27272a;
    --accent: #2dd4bf;
    --accent-hover: #5eead4;
    --accent-soft: #134e4a;
    --accent-fg: #042f2e;
    --danger: #f87171;
  }
}
* { box-sizing: border-box; }
html { background: var(--surface); }
body {
  margin: 0;
  min-height: 100vh;
  font: 14px/1.5 var(--font);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(ellipse at top, color-mix(in srgb, var(--accent-soft) 85%, transparent), transparent 55%),
    var(--surface);
}
.shell {
  width: 100%;
  max-width: 28rem;
  margin: 0 auto;
  padding: 2.5rem 1rem 3rem;
}
.brand { text-align: center; margin-bottom: 1.5rem; }
.eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
}
.brand h1 {
  margin: 0.25rem 0 0;
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--ink);
}
.lead {
  margin: 0.35rem 0 0;
  font-size: 13px;
  color: var(--ink-muted);
}
.card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  padding: 1.5rem;
}
form { display: grid; gap: 1rem; margin: 0; }
.field { display: grid; gap: 0.35rem; }
label { font-weight: 500; font-size: 12px; color: var(--ink); }
.req { color: var(--danger); margin-left: 2px; }
input, textarea, select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  background: var(--surface);
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
input::placeholder, textarea::placeholder { color: var(--ink-faint); }
input:focus-visible, textarea:focus-visible, select:focus-visible {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}
textarea { resize: vertical; min-height: 6.5rem; }
/* Consent field: label above (heading), a statement, then a checkbox per purpose. */
.field.consent { gap: 0.35rem; }
.field.consent .field-label {
  font-weight: 500;
  font-size: 12px;
  color: var(--ink);
}
.field.consent .consent-statement {
  margin: 0 0 0.35rem;
  font-size: 12px;
  color: var(--ink-muted);
}
.field.consent .consent-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 0.5rem;
  padding: 0.15rem 0;
}
.field.consent input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  margin-top: 0.2rem;
  padding: 0;
  background: var(--surface);
}
.field.consent .consent-row label {
  font-weight: 400;
  color: var(--ink);
}
.field.notice { gap: 0.35rem; }
.field.notice .field-label {
  font-weight: 500;
  font-size: 12px;
  color: var(--ink);
}
.field.notice .notice-body {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 12px;
  color: var(--ink-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-line;
}
button[type="submit"] {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-fg);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease;
}
button[type="submit"]:hover:not([disabled]) { background: var(--accent-hover); }
button[type="submit"][disabled] { opacity: 0.55; cursor: progress; }
.note { margin: 0; font-size: 12px; color: var(--ink-muted); }
.error { color: var(--danger); font-weight: 500; }
.done {
  margin: 0;
  text-align: center;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ink);
}
.paused {
  margin: 0;
  font-size: 13px;
  color: var(--ink-muted);
  text-align: center;
}
`

/**
 * Styles for the iframe document.
 *
 * Deliberately not Kelpie: system font, browser field colours, a plain button.
 * An iframe cannot pick up the host page's CSS, so the only way not to fight
 * the host is to stay neutral and leave the background transparent.
 */
const IFRAME_STYLES = `
* { box-sizing: border-box; }
html, body { background: transparent; }
body {
  margin: 0;
  padding: 12px;
  font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: CanvasText;
  -webkit-font-smoothing: antialiased;
}
.shell { margin: 0; padding: 0; }
form { display: grid; gap: 14px; margin: 0; }
.field { display: grid; gap: 5px; }
label { font-weight: 600; font-size: 0.875rem; }
.req { color: #b4232c; margin-left: 2px; }
input, textarea, select {
  width: 100%;
  padding: 9px 10px;
  border: 1px solid #b9bfc9;
  border-radius: 6px;
  font: inherit;
  background: Field;
  color: FieldText;
}
input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid #2f6feb;
  outline-offset: 1px;
}
textarea { resize: vertical; min-height: 6rem; }
.field.consent { gap: 5px; }
.field.consent .field-label { font-weight: 600; font-size: 0.875rem; color: CanvasText; }
.field.consent .consent-statement { margin: 0 0 5px; font-size: 0.8125rem; color: #5c6570; }
.field.consent .consent-row { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 8px; padding: 2px 0; }
.field.consent input[type="checkbox"] { width: 1rem; height: 1rem; margin-top: 3px; padding: 0; background: Field; }
.field.consent .consent-row label { font-weight: 400; }
.field.notice { gap: 5px; }
.field.notice .field-label { font-weight: 600; font-size: 0.875rem; color: CanvasText; }
.field.notice .notice-body { margin: 0; padding: 9px 10px; font-size: 0.8125rem; color: CanvasText; background: Field; border: 1px solid #b9bfc9; border-radius: 6px; white-space: pre-line; }
button[type="submit"] {
  width: 100%;
  padding: 10px 16px;
  border: 0;
  border-radius: 6px;
  background: #2f6feb;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button[type="submit"][disabled] { opacity: 0.6; cursor: progress; }
.note { margin: 0; font-size: 0.875rem; color: #5c6570; }
.error { color: #b4232c; font-weight: 500; }
.done { margin: 0; font-size: 15px; font-weight: 500; line-height: 1.45; }
.paused { margin: 0; font-size: 13px; color: #5c6570; }
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
    // Consent fields render a checkbox per purpose, each tagged with
    // data-consent-field=<field_id> and value=<purpose_id>. Collect the
    // ticked ones into a comma-separated list under the field id — the
    // server parses that back into a set of ticked purpose ids.
    var consentBoxes = form.querySelectorAll('input[type="checkbox"][data-consent-field]');
    var consentByField = {};
    for (var i = 0; i < consentBoxes.length; i += 1) {
      var box = consentBoxes[i];
      var fieldId = box.getAttribute('data-consent-field');
      if (!consentByField[fieldId]) { consentByField[fieldId] = []; }
      if (box.checked) { consentByField[fieldId].push(box.value); }
    }
    for (var fieldId in consentByField) {
      if (consentByField[fieldId].length > 0) {
        answers[fieldId] = consentByField[fieldId].join(',');
      }
    }
    config.fieldIds.forEach(function (id) {
      if (consentByField[id] !== undefined) { return; }
      var element = form.elements[id];
      if (!element) { return; }
      var value = element.value.trim();
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

export type EmbedLayout = 'page' | 'embed'

export interface EmbedPageOptions {
  readonly form: FormRecord
  readonly fields: readonly FormFieldRecord[]
  /** Labels for the consent purposes the fields refer to, keyed by purpose id. */
  readonly consentPurposeLabels: ReadonlyMap<string, string>
  /** Absolute URL of the public submit endpoint this page posts to. */
  readonly submitUrl: string
  /** Per-response value tying the inline style and script to the CSP header. */
  readonly nonce: string
  /** Workspace name shown above the form title on the hosted page layout. */
  readonly workspaceName: string
  /**
   * `page` is the standalone hosted URL (brand chrome). `embed` is the iframe
   * document: fields only, no page design around them.
   */
  readonly layout: EmbedLayout
}

/**
 * Public heading for the hosted page: the form's `title`, falling back to
 * `name` if somehow blank (legacy rows, a cleared field).
 */
function displayTitle(form: FormRecord): string {
  const title = form.title.trim()

  return title.length > 0 ? title : form.name
}

function renderFormBody(
  form: FormRecord,
  fields: readonly FormFieldRecord[],
  consentPurposeLabels: ReadonlyMap<string, string>,
  config: string,
  nonce: string,
): string {
  if (form.status === 'paused') {
    return `<p class="paused">This form is not accepting submissions right now.</p>`
  }

  return [
    '<form id="kelpie-form" novalidate>',
    fields.map((field) => renderField(field, consentPurposeLabels)).join(''),
    '<div><button id="kelpie-submit" type="submit">Submit</button></div>',
    '<p id="kelpie-status" class="note" role="status" aria-live="polite"></p>',
    '</form>',
    `<script type="application/json" id="kelpie-config">${config}</script>`,
    `<script nonce="${escapeHtml(nonce)}">${EMBED_SCRIPT}</script>`,
  ].join('')
}

/**
 * The whole page, as one document.
 *
 * A paused form still renders. Somebody visiting the page a customer's site
 * already embeds should be told the form is closed rather than shown a working
 * form whose submit answers 409.
 */
export function renderEmbedPage(options: EmbedPageOptions): string {
  const { form, fields, consentPurposeLabels, submitUrl, nonce, workspaceName, layout } = options
  const heading = displayTitle(form)
  const config = escapeScriptJson({
    formId: form.id,
    submitUrl,
    thankYou: form.thankYouMessage,
    fieldIds: fields.map((field) => field.id),
  })
  const formBody = renderFormBody(form, fields, consentPurposeLabels, config, nonce)

  const styles = layout === 'page' ? HOSTED_STYLES : IFRAME_STYLES
  const shell =
    layout === 'page'
      ? [
          '<div class="shell">',
          '<header class="brand">',
          `<div class="eyebrow">${escapeHtml(workspaceName)}</div>`,
          `<h1>${escapeHtml(heading)}</h1>`,
          form.description === null || form.description.trim().length === 0
            ? ''
            : `<p class="lead">${escapeHtml(form.description)}</p>`,
          '</header>',
          `<div class="card">${formBody}</div>`,
          '</div>',
        ].join('')
      : `<div class="shell">${formBody}</div>`

  return [
    '<!doctype html>',
    `<html lang="en" class="layout-${layout}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Not indexed: the canonical page for this form is the customer's own, and
    // a bare embed ranking above it would be a worse result for a reader.
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(heading)}</title>`,
    `<style nonce="${escapeHtml(nonce)}">${styles}</style>`,
    '</head>',
    `<body class="layout-${layout}">${shell}</body>`,
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

/** What a customer pastes into their site, plus the standalone hosted URL. */
export interface EmbedSnippets {
  /** Standalone hosted page (brand chrome). */
  readonly url: string
  /** Bare document the iframe snippets load (fields only). */
  readonly embedUrl: string
  readonly iframe: string
  readonly script: string
}

/**
 * The two ways to embed, plus the hosted page URL.
 *
 * Hosted `url` is the full page. The iframe snippets point at `embedUrl`, which
 * is the same form without page chrome — what belongs inside somebody else's
 * site. The plain iframe is fixed height; the script listens for height
 * messages as fields appear and as the thank-you replaces the form.
 */
export function embedSnippets(hostedUrl: string, embedUrl: string, formId: string): EmbedSnippets {
  const iframe =
    `<iframe src="${escapeHtml(embedUrl)}" title="Contact form" ` +
    `style="width:100%;border:0;height:720px" loading="lazy"></iframe>`

  const script = [
    `<iframe id="kelpie-${formId}" src="${escapeHtml(embedUrl)}" title="Contact form"`,
    `        style="width:100%;border:0;height:720px" loading="lazy"></iframe>`,
    `<script>`,
    `  window.addEventListener('message', function (event) {`,
    `    if (event.data && event.data.kelpie === 'height' && event.data.formId === '${formId}') {`,
    `      document.getElementById('kelpie-${formId}').style.height = event.data.height + 'px';`,
    `    }`,
    `  });`,
    `</script>`,
  ].join('\n')

  return { url: hostedUrl, embedUrl, iframe, script }
}

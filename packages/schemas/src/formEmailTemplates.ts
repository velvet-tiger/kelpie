import type { FormEmailKind } from './values.ts'

/**
 * The placeholders a form's email templates may use, and the one parser that
 * reads them.
 *
 * Shared by the server, which refuses an unknown placeholder when the form is
 * written and fills the template when the email is sent, and by the builder,
 * which offers the same list as chips. One list, so the chips never offer a
 * placeholder the server refuses.
 *
 * A placeholder is `{{name}}`, with optional spaces inside the braces. There is
 * no logic, no loop and no filter. A placeholder with no value fills as an
 * empty string.
 */

/**
 * Where a placeholder may appear.
 *
 * `both`: the notification and the auto-reply. `notification`: only the
 * notification, because the value is text the visitor typed. The auto-reply
 * goes to an address the visitor also typed, so visitor text in it would let
 * anyone send their own words to any address through a public form.
 */
export type FormEmailPlaceholderScope = 'both' | 'notification'

export interface FormEmailPlaceholder {
  /** What goes between the braces. */
  readonly name: string
  /** What the builder calls it. */
  readonly label: string
  readonly scope: FormEmailPlaceholderScope
}

export const FORM_EMAIL_PLACEHOLDERS: readonly FormEmailPlaceholder[] = [
  { name: 'form.name', label: 'Form name', scope: 'both' },
  { name: 'form.title', label: 'Form title', scope: 'both' },
  { name: 'workspace.name', label: 'Workspace name', scope: 'both' },
  { name: 'submitted_at', label: 'Submitted at', scope: 'both' },
  { name: 'person.email', label: 'Submitter email', scope: 'notification' },
  { name: 'person.name', label: 'Submitter name', scope: 'notification' },
  { name: 'company.name', label: 'Company name', scope: 'notification' },
  { name: 'answers', label: 'All answers', scope: 'notification' },
]

/*
 * There is no placeholder for one answer. `{{answers}}` lists them all
 * instead. A field keeps its id for as long as it is on the form, so a
 * `{{field.<id>}}` placeholder would now hold across edits; none exists yet.
 */

export const DEFAULT_NOTIFY_SUBJECT = 'New submission: {{form.name}}'
export const DEFAULT_NOTIFY_BODY = '{{answers}}'
export const DEFAULT_AUTO_REPLY_SUBJECT = 'Thanks for contacting {{workspace.name}}'
export const DEFAULT_AUTO_REPLY_BODY =
  'Thanks for getting in touch. We have your message and will reply soon.'

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/gu

/** `{{name}}`, the text a chip inserts. */
export function formEmailPlaceholderText(name: string): string {
  return `{{${name}}}`
}

/** Every placeholder name in `template`, in order, repeats included. */
export function readTemplatePlaceholders(template: string): readonly string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (match) => match[1] ?? '')
}

/** True when `name` may appear in a template of `kind`. */
export function isPlaceholderAllowed(name: string, kind: FormEmailKind): boolean {
  const known = FORM_EMAIL_PLACEHOLDERS.find((placeholder) => placeholder.name === name)

  return known !== undefined && (known.scope === 'both' || kind === 'notification')
}

/** One message for each placeholder `template` may not use, in order, each named once. */
export function findTemplatePlaceholderProblems(
  template: string,
  kind: FormEmailKind,
): readonly string[] {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const name of readTemplatePlaceholders(template)) {
    if (seen.has(name) || isPlaceholderAllowed(name, kind)) {
      continue
    }

    seen.add(name)
    problems.push(placeholderProblem(name, kind))
  }

  return problems
}

function placeholderProblem(name: string, kind: FormEmailKind): string {
  const shown = formEmailPlaceholderText(name)

  if (kind === 'auto_reply' && isPlaceholderAllowed(name, 'notification')) {
    return `${shown} is text the visitor typed, which an auto-reply cannot include`
  }

  return `${shown} is not a placeholder`
}

/**
 * Replaces every placeholder in `template` with `valueOf(name)`, or with an
 * empty string when that is undefined.
 */
export function fillFormEmailTemplate(
  template: string,
  valueOf: (name: string) => string | undefined,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => valueOf(name) ?? '')
}

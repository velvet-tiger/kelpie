import type { Hono } from 'hono'
import { z } from 'zod'

import type { CaptchaAccess } from '../../lib/captcha.ts'
import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { readJsonBody } from '../../lib/http.ts'
import { requireCapability } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { moduleCapabilityName } from '../../runtime/moduleConfig.ts'
import * as consentPurposesRepository from '../consent-purposes/repository.ts'
import * as listsRepository from '../lists/repository.ts'
import { findWorkspace } from '../workspace/repository.ts'
import { embedContentSecurityPolicy, renderEmbedPage } from './embed.ts'
import type { EmbedConsentPurpose } from './embed.ts'
import type { FormFieldRecord } from './repository.ts'
import * as repository from './repository.ts'
import { submitUrlFor, tokenUrlFor } from './routes.ts'
import type { SpamTokens } from './spam.ts'
import type { FormSubmitService, SubmitOutcome } from './submission.ts'

/**
 * `/v1/public/workspaces/:workspaceId/forms/…`: the three endpoints anybody on
 * the internet may call, with no credentials and from any origin.
 *
 * The embed page is addressed by form id, because it is what customers paste
 * into their sites and it must never move. The submit is addressed by slug, and
 * the embed page carries the current submit URL, so regenerating the slug moves
 * the submit for every embed at once.
 *
 * No handler here resolves an `Actor`, and none can: there is nothing to resolve
 * one from. The URL names the workspace, and every query underneath is scoped
 * to it. That is the whole auth story, and it is why
 * these routes are registered through `context.publicRoutes` rather than
 * `context.routes` — the mount says which they are.
 */

/**
 * `token`, `trap` and `captcha_response` are the spam check's inputs
 * (`spam.ts`). All optional: a form that does not require the check ignores
 * them, and one that does holds a submit without them as spam, which is not a
 * refusal and so not a 422.
 */
const submitBody = z.strictObject({
  answers: z.record(z.string().min(1), z.string()),
  token: z.string().optional(),
  trap: z.string().optional(),
  captcha_response: z.string().optional(),
})

export interface PublicFormRoutesDependencies {
  readonly db: Database
  /** Injected so a test can pin the value the CSP and the tags share. */
  readonly generateNonce?: () => string
  readonly submissions: FormSubmitService
  readonly spamTokens: SpamTokens
  readonly captcha: CaptchaAccess
  /** The embed of a form in a workspace that has turned the module off is refused. */
  readonly entitlements: EntitlementRegistry
}

/**
 * The purposes every consent field on this form points at, keyed by id.
 * Renders the embed with each purpose's statement (or label) beside its
 * checkbox rather than an opaque id. A purpose that has since been removed
 * drops out of the map; `renderField` falls back to the id when it does, so a
 * stale field stays visible but obviously off.
 */
async function loadConsentPurposes(
  db: Database,
  workspaceId: string,
  fields: readonly FormFieldRecord[],
): Promise<ReadonlyMap<string, EmbedConsentPurpose>> {
  const ids = Array.from(
    new Set(fields.flatMap((field) => (field.type === 'consent' ? field.consentPurposeIds : []))),
  )
  if (ids.length === 0) return new Map()
  const rows = await consentPurposesRepository.listPurposesByIds(db, workspaceId, ids)
  return new Map(rows.map((row) => [row.id, { label: row.label, statement: row.statement }]))
}

/**
 * The names of the lists every "Add to list" field on this form offers, keyed
 * by id: the default text beside each checkbox. A list that has since been
 * deleted drops out of the map, and `renderField` leaves its box out.
 */
async function loadListNames(
  db: Database,
  workspaceId: string,
  fields: readonly FormFieldRecord[],
): Promise<ReadonlyMap<string, string>> {
  const ids = Array.from(
    new Set(fields.flatMap((field) => (field.type === 'list' ? field.listIds : []))),
  )
  const rows = await listsRepository.listListsById(db, workspaceId, ids)
  return new Map(rows.map((row) => [row.id, row.name]))
}

function submitResponse(outcome: SubmitOutcome): Record<string, unknown> {
  // `status` stays off this response too: a submit the spam check held answers
  // exactly as an accepted one, so a bot cannot tell which it was.
  //
  // The upserted record ids stay off this response on purpose. The caller is an
  // unauthenticated website, and a Kelpie id is a ULID whose timestamp would tell
  // that caller whether the person or company it named was already in the CRM.
  // The service still computes them for its own events and activities; they are
  // simply not on the wire here.
  return {
    id: outcome.submissionId,
    form_id: outcome.formId,
    submitted_at: outcome.submittedAt.toISOString(),
    // Echoed so an embed can render the confirmation without a second request
    // for a form definition it has no other reason to fetch.
    thank_you_message: outcome.thankYouMessage,
  }
}

export function mountPublicFormRoutes(
  router: Hono,
  dependencies: PublicFormRoutesDependencies,
): void {
  const generateNonce = dependencies.generateNonce ?? (() => crypto.randomUUID())

  router.post('/workspaces/:workspaceId/forms/:slug/submit', async (context) => {
    const body = await readJsonBody(context, submitBody)
    const outcome = await dependencies.submissions.submit(
      context.req.param('workspaceId'),
      context.req.param('slug'),
      body.answers,
      { token: body.token, trap: body.trap, captchaResponse: body.captcha_response },
    )

    return context.json(submitResponse(outcome), 201)
  })

  /**
   * A spam-check token for one form, issued now.
   *
   * Its own request, never part of the embed page: that page is cached and
   * shared, and the check reads the token's age as the time this visitor took.
   * Addressed by form id, like the embed, so it does not move with the slug. A
   * form that does not require the check still answers, because a token costs
   * nothing and a page should not have to know the setting to ask.
   */
  router.get('/workspaces/:workspaceId/forms/:formId/token', async (context) => {
    const form = await repository.findForm(
      dependencies.db,
      context.req.param('workspaceId'),
      context.req.param('formId'),
    )

    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    await requireCapability(dependencies.entitlements, form.workspaceId, moduleCapabilityName('forms'))

    context.header('Cache-Control', 'no-store')

    return context.json({ token: dependencies.spamTokens.issue(form.id) })
  })

  /**
   * The hosted page a customer's site frames.
   *
   * Served here rather than by the React application: this loads inside somebody
   * else's marketing site, and it has no business bringing the CRM bundle with
   * it. A paused form still renders, and says so; only its submit is closed.
   */
  router.get('/workspaces/:workspaceId/forms/:formId/embed', async (context) => {
    const form = await repository.findForm(
      dependencies.db,
      context.req.param('workspaceId'),
      context.req.param('formId'),
    )

    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    // Ungated by the runtime, like the submit route: a workspace with the forms
    // module off does not serve its embed either.
    await requireCapability(dependencies.entitlements, form.workspaceId, moduleCapabilityName('forms'))

    const workspace = await findWorkspace(dependencies.db, form.workspaceId)

    if (workspace === undefined) {
      throw AppError.notFound('Form not found')
    }

    // `view=page` is the standalone hosted URL (brand chrome). The default —
    // and what iframe snippets load — is the bare embed: fields only.
    const layout = context.req.query('view') === 'page' ? 'page' : 'embed'

    const nonce = generateNonce()
    // Drawn only on a form that requires the check: a widget on a form that
    // would accept the submit without it is friction that stops nobody.
    const captcha = form.requireSpamCheck ? dependencies.captcha.current()?.widget : undefined
    const fields = await repository.listFields(dependencies.db, form.id)
    const [consentPurposes, listNames] = await Promise.all([
      loadConsentPurposes(dependencies.db, form.workspaceId, fields),
      loadListNames(dependencies.db, form.workspaceId, fields),
    ])
    const page = renderEmbedPage({
      form,
      fields,
      consentPurposes,
      listNames,
      submitUrl: submitUrlFor(context, form.workspaceId, form.slug),
      nonce,
      workspaceName: workspace.name,
      layout,
      spamCheck: form.requireSpamCheck
        ? { tokenUrl: tokenUrlFor(context, form.workspaceId, form.id), captcha }
        : undefined,
    })

    context.header('Content-Security-Policy', embedContentSecurityPolicy(nonce, captcha))
    // The page is per-form and changes whenever the form is edited. A short
    // shared cache keeps a popular landing page off the database on every view
    // without leaving an edited form stale for long. That includes the submit
    // URL: for up to this long after a slug change, a cached page still posts
    // to the old slug and gets a 404.
    context.header('Cache-Control', 'public, max-age=60')

    return context.html(page)
  })
}

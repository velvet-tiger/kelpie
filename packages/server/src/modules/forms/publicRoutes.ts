import { createHash } from 'node:crypto'

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
import { submitPathFor, tokenPathFor } from './routes.ts'
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
/**
 * The most characters one answer may carry. The caller has no credentials, and
 * an answer is stored and then copied to a note or a record. The request body
 * limit (`lib/bodyLimit.ts`) is the outer limit; this one refuses a single
 * field that is far longer than any form asks for.
 */
const MAX_ANSWER_LENGTH = 20_000

/** Field ids are generated and short. Spam check values are tokens. */
const MAX_FIELD_ID_LENGTH = 200
const MAX_SPAM_VALUE_LENGTH = 8192

const submitBody = z.strictObject({
  answers: z.record(
    z.string().min(1).max(MAX_FIELD_ID_LENGTH),
    z.string().max(MAX_ANSWER_LENGTH),
  ),
  token: z.string().max(MAX_SPAM_VALUE_LENGTH).optional(),
  trap: z.string().max(MAX_SPAM_VALUE_LENGTH).optional(),
  captcha_response: z.string().max(MAX_SPAM_VALUE_LENGTH).optional(),
})

export interface PublicFormRoutesDependencies {
  readonly db: Database
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
      submitUrl: submitPathFor(form.workspaceId, form.slug),
      workspaceName: workspace.name,
      layout,
      spamCheck: form.requireSpamCheck
        ? { tokenUrl: tokenPathFor(form.workspaceId, form.id), captcha }
        : undefined,
    })

    const policy = embedContentSecurityPolicy(layout, captcha)
    const etag = embedEtag(page, policy)

    // Every load asks again. An edit gives every field a new id, and a page
    // kept from before the edit gets a 409 on submit that a reload must cure.
    // An unchanged page costs a 304 and no body.
    //
    // Shared caches may still store this page, so nothing in it comes from a
    // request header: the submit and token URLs are paths on the page's own
    // origin.
    context.header('Cache-Control', 'no-cache')
    context.header('ETag', etag)
    // On the 304 too. A browser merges a 304's headers into the stored page,
    // and a response with no policy gets `X-Frame-Options: DENY` from the
    // security headers middleware, which would stop the stored page framing.
    context.header('Content-Security-Policy', policy)

    if (matchesEtag(context.req.header('If-None-Match'), etag)) {
      return context.body(null, 304)
    }

    return context.html(page)
  })
}

/**
 * A strong validator over everything the browser keeps from a 200: the body
 * and the policy that lets its inline tags run. A 304 tells the browser to
 * reuse both, so a change to either must change the tag.
 */
function embedEtag(page: string, policy: string): string {
  const digest = createHash('sha256').update(policy, 'utf8').update('\n').update(page, 'utf8')

  return `"${digest.digest('base64url')}"`
}

/**
 * Whether an `If-None-Match` header names this tag. The comparison is weak, as
 * RFC 9110 asks for this header, so a `W/` prefix a proxy added still matches.
 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false
  }

  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//u, '') === etag)
}

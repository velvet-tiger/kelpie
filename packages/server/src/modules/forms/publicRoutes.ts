import type { Hono } from 'hono'
import { z } from 'zod'

import type { Database } from '../../lib/database.ts'
import { AppError } from '../../lib/errors.ts'
import { PUBLIC_ROUTE_PREFIX, readJsonBody, requestOrigin } from '../../lib/http.ts'
import { requireCapability } from '../../runtime/entitlements.ts'
import type { EntitlementRegistry } from '../../runtime/entitlements.ts'
import { moduleCapabilityName } from '../../runtime/moduleConfig.ts'
import { embedContentSecurityPolicy, renderEmbedPage } from './embed.ts'
import * as repository from './repository.ts'
import type { FormSubmitService, SubmitOutcome } from './submission.ts'

/**
 * `/v1/public/forms/:publicKey/…`: the two endpoints anybody on the internet may
 * call, with no credentials and from any origin.
 *
 * No handler here resolves an `Actor`, and none can: there is nothing to resolve
 * one from. The workspace comes from the form the `publicKey` names, and every
 * query underneath is scoped to it. That is the whole auth story, and it is why
 * these routes are registered through `context.publicRoutes` rather than
 * `context.routes` — the mount says which they are.
 */

const submitBody = z.strictObject({
  answers: z.record(z.string().min(1), z.string()),
})

export interface PublicFormRoutesDependencies {
  readonly db: Database
  /** Injected so a test can pin the value the CSP and the tags share. */
  readonly generateNonce?: () => string
  readonly submissions: FormSubmitService
  /** The embed of a form in a workspace that has turned the module off is refused. */
  readonly entitlements: EntitlementRegistry
}

function submitResponse(outcome: SubmitOutcome): Record<string, unknown> {
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

  router.post('/forms/:publicKey/submit', async (context) => {
    const body = await readJsonBody(context, submitBody)
    const outcome = await dependencies.submissions.submit(context.req.param('publicKey'), body.answers)

    return context.json(submitResponse(outcome), 201)
  })

  /**
   * The hosted page a customer's site frames.
   *
   * Served here rather than by the React application: this loads inside somebody
   * else's marketing site, and it has no business bringing the CRM bundle with
   * it. A paused form still renders, and says so; only its submit is closed.
   */
  router.get('/forms/:publicKey/embed', async (context) => {
    const publicKey = context.req.param('publicKey')
    const form = await repository.findFormByPublicKey(dependencies.db, publicKey)

    if (form === undefined) {
      throw AppError.notFound('Form not found')
    }

    // Ungated by the runtime, like the submit route: a workspace with the forms
    // module off does not serve its embed either.
    await requireCapability(dependencies.entitlements, form.workspaceId, moduleCapabilityName('forms'))

    const nonce = generateNonce()
    const page = renderEmbedPage({
      form,
      fields: await repository.listFields(dependencies.db, form.id),
      submitUrl: `${requestOrigin(context)}${PUBLIC_ROUTE_PREFIX}/forms/${publicKey}/submit`,
      nonce,
    })

    context.header('Content-Security-Policy', embedContentSecurityPolicy(nonce))
    // The page is per-form and changes whenever the form is edited. A short
    // shared cache keeps a popular landing page off the database on every view
    // without leaving an edited form stale for long.
    context.header('Cache-Control', 'public, max-age=60')

    return context.html(page)
  })
}

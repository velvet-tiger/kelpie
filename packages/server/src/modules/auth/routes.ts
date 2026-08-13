import { THEME_PREFERENCES } from '@kelpie/schemas'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import { timezoneSchema } from '../../lib/timezones.ts'
import { requireSessionActor } from './actor.ts'
import type { SessionActor } from './actor.ts'
import { resolveActorFrom } from './credentials.ts'
import type { CredentialDependencies } from './credentials.ts'
import type { PreferenceValues } from './preferences.ts'
import type { AccountView, AuthService, IssuedSession, SessionView } from './service.ts'
import { clearSessionCookie, writeSessionCookie } from './session.ts'
import type { SessionCookieOptions } from './session.ts'

/**
 * Wire shapes for `/v1/auth/*`. Bodies are `snake_case` per `api.md`; the service
 * layer speaks `camelCase`. The mapping happens here and nowhere else.
 */

const signUpBody = z.object({
  email: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(1),
  /** Where the emailed verification link points. `{token}` is replaced with the token. */
  verify_url_template: z.string().min(1).includes('{token}'),
})

const logInBody = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
})

const resetRequestBody = z.object({
  email: z.string().min(1),
  /** Where the emailed link points. `{token}` is replaced with the reset token. */
  reset_url_template: z.string().min(1).includes('{token}'),
})

const resetConfirmBody = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
})

const changePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
})

const verifyEmailRequestBody = z.object({
  /** Where the emailed link points. `{token}` is replaced with the verification token. */
  verify_url_template: z.string().min(1).includes('{token}'),
})

const verifyEmailConfirmBody = z.object({
  token: z.string().min(1),
})

const updateAccountBody = z
  .strictObject({
    name: z.string().min(1),
    email: z.string().min(1),
    current_password: z.string().min(1),
  })
  .partial()
  .refine((body) => body.email === undefined || body.current_password !== undefined, {
    message: 'Current password is required to change email',
    path: ['current_password'],
  })

const updatePreferencesBody = z
  .strictObject({
    timezone: timezoneSchema,
    theme: z.enum(THEME_PREFERENCES),
    email_digest: z.boolean(),
    mention_emails: z.boolean(),
    product_updates: z.boolean(),
  })
  .partial()

export interface AuthRoutesDependencies extends CredentialDependencies {
  readonly service: AuthService
  readonly cookie: SessionCookieOptions
}

/** Parses a body into `T` or throws the `422` `api.md` describes. */
async function readBody<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await context.req.json().catch(() => {
    throw new AppError('bad_request', 'Body must be valid JSON')
  })
  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    throw AppError.validationFailed('Request body is invalid', toErrorDetails(parsed.error.issues))
  }

  return parsed.data
}

/** The device and location shown on the Security page come from the request itself. */
function describeClient(context: Context): { device?: string; location?: string } {
  const userAgent = context.req.header('User-Agent')

  return userAgent === undefined ? {} : { device: userAgent }
}

function accountResponse(issued: IssuedSession): Record<string, unknown> {
  return {
    account: accountBody(issued.account),
    active_workspace_id: issued.activeWorkspaceId,
  }
}

function accountBody(account: AccountView): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    email_verified: account.emailVerified,
  }
}

function preferencesResponse(preferences: PreferenceValues): Record<string, unknown> {
  return {
    timezone: preferences.timezone,
    theme: preferences.theme,
    email_digest: preferences.emailDigest,
    mention_emails: preferences.mentionEmails,
    product_updates: preferences.productUpdates,
  }
}

function sessionResponse(session: SessionView): Record<string, unknown> {
  return {
    id: session.id,
    device: session.device,
    location: session.location,
    last_active_at: session.lastActiveAt.toISOString(),
    current: session.current,
  }
}

export function mountAuthRoutes(router: Hono, dependencies: AuthRoutesDependencies): void {
  /** Every endpoint here manages a human's own credentials, so a key cannot call them. */
  const requireActor = async (context: Context): Promise<SessionActor> =>
    requireSessionActor(await resolveActorFrom(dependencies, context))

  router.post('/auth/signup', async (context) => {
    const body = await readBody(context, signUpBody)
    const issued = await dependencies.service.signUp({
      email: body.email,
      name: body.name,
      password: body.password,
      verifyUrlTemplate: body.verify_url_template,
      ...describeClient(context),
    })

    writeSessionCookie(context, issued.sessionToken, dependencies.cookie)

    return context.json(accountResponse(issued), 201)
  })

  router.post('/auth/login', async (context) => {
    const body = await readBody(context, logInBody)
    const issued = await dependencies.service.logIn({ ...body, ...describeClient(context) })

    writeSessionCookie(context, issued.sessionToken, dependencies.cookie)

    return context.json(accountResponse(issued), 200)
  })

  router.post('/auth/logout', async (context) => {
    await dependencies.service.logOut(await requireActor(context))
    clearSessionCookie(context, dependencies.cookie)

    return context.body(null, 204)
  })

  router.get('/auth/me', async (context) => {
    const actor = await requireActor(context)
    const account = await dependencies.service.getAccount(actor)

    return context.json({
      user_id: actor.userId,
      session_id: actor.sessionId,
      workspace_id: actor.workspaceId,
      role: actor.role,
      email_verified: account.emailVerified,
    })
  })

  /**
   * `/account` rather than `/auth/account`: `/auth/*` is how a browser gets a
   * session, and this is the person that session belongs to. The auth module
   * owns both because it owns the `users` table.
   */
  router.get('/account', async (context) =>
    context.json(accountBody(await dependencies.service.getAccount(await requireActor(context)))),
  )

  router.patch('/account', async (context) => {
    const body = await readBody(context, updateAccountBody)
    const account = await dependencies.service.updateAccount(await requireActor(context), {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.current_password === undefined ? {} : { currentPassword: body.current_password }),
    })

    return context.json(accountBody(account))
  })

  router.get('/account/preferences', async (context) =>
    context.json(
      preferencesResponse(await dependencies.service.getPreferences(await requireActor(context))),
    ),
  )

  router.patch('/account/preferences', async (context) => {
    const body = await readBody(context, updatePreferencesBody)
    const preferences = await dependencies.service.updatePreferences(await requireActor(context), {
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.theme === undefined ? {} : { theme: body.theme }),
      ...(body.email_digest === undefined ? {} : { emailDigest: body.email_digest }),
      ...(body.mention_emails === undefined ? {} : { mentionEmails: body.mention_emails }),
      ...(body.product_updates === undefined ? {} : { productUpdates: body.product_updates }),
    })

    return context.json(preferencesResponse(preferences))
  })

  router.get('/auth/sessions', async (context) => {
    const sessions = await dependencies.service.listSessions(await requireActor(context))

    return context.json({ data: sessions.map(sessionResponse), next_cursor: null })
  })

  router.delete('/auth/sessions/:id', async (context) => {
    await dependencies.service.revokeSession(await requireActor(context), context.req.param('id'))

    return context.body(null, 204)
  })

  router.patch('/auth/password', async (context) => {
    const body = await readBody(context, changePasswordBody)
    await dependencies.service.changePassword(
      await requireActor(context),
      body.current_password,
      body.new_password,
    )

    return context.body(null, 204)
  })

  /**
   * Answers 202 whether or not the address is registered. A different answer
   * would turn this endpoint into an account-existence oracle.
   */
  router.post('/auth/password-reset', async (context) => {
    const body = await readBody(context, resetRequestBody)
    await dependencies.service.requestPasswordReset(body.email, body.reset_url_template)

    return context.body(null, 202)
  })

  router.post('/auth/password-reset/confirm', async (context) => {
    const body = await readBody(context, resetConfirmBody)
    await dependencies.service.confirmPasswordReset(body.token, body.password)

    return context.body(null, 204)
  })

  /** Also what a "resend" button calls: a fresh token each time, and a no-op once verified. */
  router.post('/auth/verify-email', async (context) => {
    const body = await readBody(context, verifyEmailRequestBody)
    await dependencies.service.requestEmailVerification(await requireActor(context), body.verify_url_template)

    return context.body(null, 202)
  })

  router.post('/auth/verify-email/confirm', async (context) => {
    const body = await readBody(context, verifyEmailConfirmBody)
    await dependencies.service.confirmEmailVerification(body.token)

    return context.body(null, 204)
  })
}

import { getCookie } from 'hono/cookie'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import type { Actor } from './actor.ts'
import type { AuthService, IssuedSession, SessionView } from './service.ts'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  resolveActor,
  writeSessionCookie,
} from './session.ts'
import type { SessionCookieOptions, SessionResolverDependencies } from './session.ts'

/**
 * Wire shapes for `/v1/auth/*`. Bodies are `snake_case` per `api.md`; the service
 * layer speaks `camelCase`. The mapping happens here and nowhere else.
 */

const signUpBody = z.object({
  email: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(1),
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

export interface AuthRoutesDependencies extends SessionResolverDependencies {
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
    account: { id: issued.account.id, email: issued.account.email, name: issued.account.name },
    active_workspace_id: issued.activeWorkspaceId,
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
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActor(dependencies, getCookie(context, SESSION_COOKIE))

  router.post('/auth/signup', async (context) => {
    const body = await readBody(context, signUpBody)
    const issued = await dependencies.service.signUp({ ...body, ...describeClient(context) })

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

    return context.json({
      user_id: actor.userId,
      session_id: actor.sessionId,
      workspace_id: actor.workspaceId,
      role: actor.role,
    })
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
}

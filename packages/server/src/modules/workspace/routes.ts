import { getCookie } from 'hono/cookie'
import type { Context, Hono } from 'hono'
import { z } from 'zod'

import { AppError, toErrorDetails } from '../../lib/errors.ts'
import type { Actor } from '../auth/actor.ts'
import { SESSION_COOKIE, resolveActor } from '../auth/session.ts'
import type { SessionResolverDependencies } from '../auth/session.ts'
import { INVITABLE_ROLES } from './roles.ts'
import type { InviteView, MemberView, WorkspaceService, WorkspaceView } from './service.ts'

/** Wire shapes for `/v1/workspaces`, per `onboarding.md`'s API sketch. */

/** Lowercase letters, digits, and hyphens: it appears in URLs. */
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const createBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(63).regex(slugPattern, 'Use lowercase letters, digits, and hyphens'),
  timezone: z.string().min(1),
})

const updateBody = z
  .object({
    name: z.string().min(1),
    timezone: z.string().min(1),
    tagline: z.string().nullable(),
    one_liner: z.string().nullable(),
  })
  .partial()

const inviteBody = z.object({
  email: z.string().min(1),
  role: z.enum(INVITABLE_ROLES),
  invite_url_template: z.string().min(1).includes('{token}'),
})

const acceptBody = z.object({ token: z.string().min(1) })

export interface WorkspaceRoutesDependencies extends SessionResolverDependencies {
  readonly service: WorkspaceService
}

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

function workspaceResponse(workspace: WorkspaceView): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    timezone: workspace.timezone,
    tagline: workspace.tagline,
    one_liner: workspace.oneLiner,
  }
}

function memberResponse(member: MemberView): Record<string, unknown> {
  return {
    id: member.id,
    user_id: member.userId,
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
  }
}

function inviteResponse(invite: InviteView): Record<string, unknown> {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expires_at: invite.expiresAt.toISOString(),
  }
}

export function mountWorkspaceRoutes(router: Hono, dependencies: WorkspaceRoutesDependencies): void {
  const requireActor = (context: Context): Promise<Actor> =>
    resolveActor(dependencies, getCookie(context, SESSION_COOKIE))

  router.post('/workspaces', async (context) => {
    const body = await readBody(context, createBody)
    const workspace = await dependencies.service.create(await requireActor(context), body)

    return context.json(workspaceResponse(workspace), 201)
  })

  router.get('/workspaces/:id', async (context) => {
    const workspace = await dependencies.service.get(await requireActor(context), context.req.param('id'))

    return context.json(workspaceResponse(workspace))
  })

  router.patch('/workspaces/:id', async (context) => {
    const body = await readBody(context, updateBody)
    const workspace = await dependencies.service.update(await requireActor(context), context.req.param('id'), {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.tagline === undefined ? {} : { tagline: body.tagline }),
      ...(body.one_liner === undefined ? {} : { oneLiner: body.one_liner }),
    })

    return context.json(workspaceResponse(workspace))
  })

  router.get('/workspaces/:id/members', async (context) => {
    const members = await dependencies.service.listMembers(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json({ data: members.map(memberResponse), next_cursor: null })
  })

  router.post('/workspaces/:id/invites', async (context) => {
    const body = await readBody(context, inviteBody)
    const invite = await dependencies.service.invite(
      await requireActor(context),
      context.req.param('id'),
      body.email,
      body.role,
      body.invite_url_template,
    )

    return context.json(inviteResponse(invite), 201)
  })

  router.get('/workspaces/:id/invites', async (context) => {
    const invites = await dependencies.service.listInvites(
      await requireActor(context),
      context.req.param('id'),
    )

    return context.json({ data: invites.map(inviteResponse), next_cursor: null })
  })

  /** Not nested under a workspace: the caller does not know which one until it resolves. */
  router.post('/invites/accept', async (context) => {
    const body = await readBody(context, acceptBody)
    const workspace = await dependencies.service.acceptInvite(await requireActor(context), body.token)

    return context.json(workspaceResponse(workspace))
  })
}

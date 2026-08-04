import { z } from 'zod'

import type { Account } from './account.ts'
import { MEMBER_ROLES } from './values.ts'
import type { MemberRole } from './values.ts'
import { definedFields, idSchema } from './wire.ts'

/**
 * Wire shapes for the endpoints a signed-in browser needs before it can render
 * anything: who the session belongs to, and which workspace it is in.
 *
 * `workspaceId` is nullable because signup creates an account and nothing else.
 * Every CRM endpoint answers `403` until a workspace exists, so the shell has to
 * be able to tell "signed out" from "signed in, no workspace yet".
 */

export interface Session {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
}

export const sessionSchema: z.ZodType<Session, unknown> = z
  .object({
    user_id: idSchema,
    session_id: idSchema,
    workspace_id: idSchema.nullable(),
    role: z.enum(MEMBER_ROLES).nullable(),
  })
  .transform(
    (wire): Session => ({
      userId: wire.user_id,
      sessionId: wire.session_id,
      workspaceId: wire.workspace_id,
      role: wire.role,
    }),
  )

/** What `POST /v1/auth/login` and `/v1/auth/signup` answer with. */
export interface SignedInAccount {
  readonly account: Account
  readonly activeWorkspaceId: string | null
}

export const signedInAccountSchema: z.ZodType<SignedInAccount, unknown> = z
  .object({
    account: z.object({ id: idSchema, email: z.string(), name: z.string() }),
    active_workspace_id: idSchema.nullable(),
  })
  .transform(
    (wire): SignedInAccount => ({
      account: wire.account,
      activeWorkspaceId: wire.active_workspace_id,
    }),
  )

export interface Workspace {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly timezone: string
  readonly tagline: string | null
  readonly oneLiner: string | null
}

export const workspaceSchema: z.ZodType<Workspace, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    tagline: z.string().nullable(),
    one_liner: z.string().nullable(),
  })
  .transform(
    (wire): Workspace => ({
      id: wire.id,
      name: wire.name,
      slug: wire.slug,
      timezone: wire.timezone,
      tagline: wire.tagline,
      oneLiner: wire.one_liner,
    }),
  )

export interface CreateWorkspaceInput {
  readonly name: string
  readonly slug: string
  readonly timezone: string
}

export function createWorkspaceBody(input: CreateWorkspaceInput): Record<string, unknown> {
  return { name: input.name, slug: input.slug, timezone: input.timezone }
}

/**
 * Settings a workspace admin can change.
 *
 * `tagline` and `oneLiner` are the two strings an agent reads to say who this
 * company is, so `null` clears them and `undefined` leaves them alone, per
 * `api.md`. `definedFields` is what keeps those two apart on the wire.
 */
export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly slug?: string
  readonly timezone?: string
  readonly tagline?: string | null
  readonly oneLiner?: string | null
}

export function updateWorkspaceBody(input: UpdateWorkspaceInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    slug: input.slug,
    timezone: input.timezone,
    tagline: input.tagline,
    one_liner: input.oneLiner,
  })
}

export interface LogInInput {
  readonly email: string
  readonly password: string
}

export function logInBody(input: LogInInput): Record<string, unknown> {
  return { email: input.email, password: input.password }
}

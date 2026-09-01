import { z } from 'zod'

import { accountSchema } from './account.ts'
import type { Account } from './account.ts'
import { MEMBER_ROLES } from './values.ts'
import type { MemberRole } from './values.ts'
import { definedFields, idSchema } from './wire.ts'

/**
 * Wire shapes for `/v1/auth/*` and `/v1/workspaces`: how a browser gets a
 * session, and which workspace that session is in.
 *
 * `workspaceId` is nullable because signup creates an account and nothing else.
 * Every CRM endpoint answers `403` until a workspace exists, so the shell has to
 * be able to tell "signed out" from "signed in, no workspace yet".
 *
 * The password-reset pair belongs here rather than in `account.ts` for the same
 * reason sign-in does: a caller running them has no account context yet. What
 * `account.ts` holds is the signed-in person.
 */

export interface Session {
  readonly userId: string
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly role: MemberRole | null
  readonly emailVerified: boolean
}

export const sessionSchema: z.ZodType<Session, unknown> = z
  .object({
    user_id: idSchema,
    session_id: idSchema,
    workspace_id: idSchema.nullable(),
    role: z.enum(MEMBER_ROLES).nullable(),
    email_verified: z.boolean(),
  })
  .transform(
    (wire): Session => ({
      userId: wire.user_id,
      sessionId: wire.session_id,
      workspaceId: wire.workspace_id,
      role: wire.role,
      emailVerified: wire.email_verified,
    }),
  )

/** What `POST /v1/auth/login` and `/v1/auth/signup` answer with. */
export interface SignedInAccount {
  readonly account: Account
  readonly activeWorkspaceId: string | null
}

export const signedInAccountSchema: z.ZodType<SignedInAccount, unknown> = z
  .object({
    account: accountSchema,
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
}

export const workspaceSchema: z.ZodType<Workspace, unknown> = z
  .object({
    id: idSchema,
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
  })
  .transform(
    (wire): Workspace => ({
      id: wire.id,
      name: wire.name,
      slug: wire.slug,
      timezone: wire.timezone,
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

/** Settings a workspace admin can change. */
export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly slug?: string
  readonly timezone?: string
}

export function updateWorkspaceBody(input: UpdateWorkspaceInput): Record<string, unknown> {
  return definedFields({
    name: input.name,
    slug: input.slug,
    timezone: input.timezone,
  })
}

export interface LogInInput {
  readonly email: string
  readonly password: string
}

export function logInBody(input: LogInInput): Record<string, unknown> {
  return { email: input.email, password: input.password }
}

/**
 * Creating an account. It answers the same shape sign-in does, with
 * `activeWorkspaceId` null: signup makes the user and stops there.
 *
 * The verification link is built by the service from its own configured base
 * URL, so the caller sends no URL.
 */
export interface SignUpInput {
  readonly name: string
  readonly email: string
  readonly password: string
}

export function signUpBody(input: SignUpInput): Record<string, unknown> {
  return {
    name: input.name,
    email: input.email,
    password: input.password,
  }
}

/**
 * Asking for a reset link.
 *
 * The reset link is built by the service from its own configured base URL, so
 * the caller sends only the address.
 */
export interface RequestPasswordResetInput {
  readonly email: string
}

export function requestPasswordResetBody(
  input: RequestPasswordResetInput,
): Record<string, unknown> {
  return { email: input.email }
}

/** Spending the token from that email. Answers `204`; it does not sign anyone in. */
export interface ConfirmPasswordResetInput {
  readonly token: string
  readonly password: string
}

export function confirmPasswordResetBody(
  input: ConfirmPasswordResetInput,
): Record<string, unknown> {
  return { token: input.token, password: input.password }
}

/** Spending the token from that email. Answers `204` and does not sign anyone in or out. */
export interface ConfirmEmailVerificationInput {
  readonly token: string
}

export function confirmEmailVerificationBody(
  input: ConfirmEmailVerificationInput,
): Record<string, unknown> {
  return { token: input.token }
}

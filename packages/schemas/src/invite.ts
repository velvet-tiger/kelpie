import { z } from 'zod'

import { INVITABLE_ROLES, INVITE_STATUSES } from './values.ts'
import type { InvitableRole } from './values.ts'
import { idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shapes for `/v1/workspaces/:id/invites`.
 *
 * `status` is derived from `expires_at` rather than stored, so a workspace that
 * nobody has looked at still reports its stale invitations correctly. Nothing
 * sweeps the table.
 *
 * Both write bodies carry `invite_url_template`: the service sends the email and
 * has no idea what URL the caller's browser or agent is reachable at, so the
 * caller supplies the address the token goes into.
 */

export interface Invite {
  readonly id: string
  readonly email: string
  readonly role: InvitableRole
  readonly status: (typeof INVITE_STATUSES)[number]
  readonly expiresAt: Date
  readonly createdAt: Date
}

export const inviteSchema: z.ZodType<Invite, unknown> = z
  .object({
    id: idSchema,
    email: z.string(),
    role: z.enum(INVITABLE_ROLES),
    status: z.enum(INVITE_STATUSES),
    expires_at: timestampSchema,
    created_at: timestampSchema,
  })
  .transform(
    (wire): Invite => ({
      id: wire.id,
      email: wire.email,
      role: wire.role,
      status: wire.status,
      expiresAt: wire.expires_at,
      createdAt: wire.created_at,
    }),
  )

export interface CreateInviteInput {
  readonly email: string
  readonly role: InvitableRole
  /** An absolute URL containing the literal `{token}`, which the email replaces. */
  readonly inviteUrlTemplate: string
}

export function createInviteBody(input: CreateInviteInput): Record<string, unknown> {
  return {
    email: input.email,
    role: input.role,
    invite_url_template: input.inviteUrlTemplate,
  }
}

export interface ResendInviteInput {
  readonly inviteUrlTemplate: string
}

export function resendInviteBody(input: ResendInviteInput): Record<string, unknown> {
  return { invite_url_template: input.inviteUrlTemplate }
}

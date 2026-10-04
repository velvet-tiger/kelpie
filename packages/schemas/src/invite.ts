import { z } from 'zod'

import { INVITABLE_ROLES, INVITE_STATUSES } from './values.ts'
import type { InvitableRole } from './values.ts'
import { idSchema, nullableTimestampSchema, timestampSchema } from './wire.ts'

/**
 * Wire shapes for `/v1/workspaces/:id/invites`.
 *
 * `status` is derived from `expires_at` rather than stored, so a workspace that
 * nobody has looked at still reports its stale invitations correctly. Nothing
 * sweeps the table.
 *
 * The invitation link is built by the service from its own configured base URL,
 * so no write body carries a URL.
 *
 * The email goes out after the request, from a queue. `email_failed_at` and
 * `email_failure` say when and why it was not delivered: the mail system
 * refused it for good, or the last retry failed. Both are `null` while the
 * email is on its way or has been sent, and after a resend.
 */

export interface Invite {
  readonly id: string
  readonly email: string
  readonly role: InvitableRole
  readonly status: (typeof INVITE_STATUSES)[number]
  readonly expiresAt: Date
  /** When the invitation email failed for the last time, or null. */
  readonly emailFailedAt: Date | null
  /** Why the invitation email was not delivered, or null. Short, one line. */
  readonly emailFailure: string | null
  readonly createdAt: Date
}

export const inviteSchema: z.ZodType<Invite, unknown> = z
  .object({
    id: idSchema,
    email: z.string(),
    role: z.enum(INVITABLE_ROLES),
    status: z.enum(INVITE_STATUSES),
    expires_at: timestampSchema,
    email_failed_at: nullableTimestampSchema,
    email_failure: z.string().nullable(),
    created_at: timestampSchema,
  })
  .transform(
    (wire): Invite => ({
      id: wire.id,
      email: wire.email,
      role: wire.role,
      status: wire.status,
      expiresAt: wire.expires_at,
      emailFailedAt: wire.email_failed_at,
      emailFailure: wire.email_failure,
      createdAt: wire.created_at,
    }),
  )

export interface CreateInviteInput {
  readonly email: string
  readonly role: InvitableRole
}

export function createInviteBody(input: CreateInviteInput): Record<string, unknown> {
  return {
    email: input.email,
    role: input.role,
  }
}

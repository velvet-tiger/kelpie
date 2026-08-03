import { z } from 'zod'

import { MEMBER_ROLES } from './values.ts'
import type { MemberRole } from './values.ts'
import { idSchema, timestampSchema } from './wire.ts'

/**
 * Wire shape for `GET /v1/workspaces/:id/members`.
 *
 * `id` is the membership, not the user. Notes and activities attribute to this
 * id, so it is what a panel keys its name lookup on.
 */

export interface Member {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly email: string
  readonly role: MemberRole
  readonly joinedAt: Date
}

export const memberSchema: z.ZodType<Member, unknown> = z
  .object({
    id: idSchema,
    user_id: idSchema,
    name: z.string(),
    email: z.string(),
    role: z.enum(MEMBER_ROLES),
    joined_at: timestampSchema,
  })
  .transform(
    (wire): Member => ({
      id: wire.id,
      userId: wire.user_id,
      name: wire.name,
      email: wire.email,
      role: wire.role,
      joinedAt: wire.joined_at,
    }),
  )

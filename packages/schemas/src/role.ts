import { z } from 'zod'

import { ROLE_STATUSES } from './values.ts'
import type { RoleStatus } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/roles`, an opening the workspace is hiring for.
 *
 * A Role holds no people. Candidates attach through `/v1/candidates`, which is
 * the Person↔Role link and the only place hiring pipeline state lives.
 */

export interface Role extends RecordTimestamps {
  readonly id: string
  readonly title: string
  readonly status: RoleStatus
}

export const roleSchema: z.ZodType<Role, unknown> = z
  .object({
    id: idSchema,
    title: z.string(),
    status: z.enum(ROLE_STATUSES),
    ...recordTimestamps,
  })
  .transform(
    (wire): Role => ({
      id: wire.id,
      title: wire.title,
      status: wire.status,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface RoleInput {
  readonly title?: string
  readonly status?: RoleStatus
}

export function roleBody(input: RoleInput): Record<string, unknown> {
  return definedFields({ title: input.title, status: input.status })
}

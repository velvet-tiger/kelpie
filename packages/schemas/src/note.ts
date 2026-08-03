import { z } from 'zod'

import { RECORD_TARGET_TYPES } from './values.ts'
import type { RecordTargetType } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/notes`.
 *
 * `authorId` is a workspace member id, not a user id. It is null when no member
 * was behind the write, which today means a workspace API key. Resolving it to a
 * name is the caller's job: `api.md` has no include-expansion, so a panel joins
 * against the workspace member list it already holds.
 */

export interface Note extends RecordTimestamps {
  readonly id: string
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly authorId: string | null
  readonly pinned: boolean
}

export const noteSchema: z.ZodType<Note, unknown> = z
  .object({
    id: idSchema,
    target_type: z.enum(RECORD_TARGET_TYPES),
    target_id: idSchema,
    body: z.string(),
    author_id: idSchema.nullable(),
    pinned: z.boolean(),
    ...recordTimestamps,
  })
  .transform(
    (wire): Note => ({
      id: wire.id,
      targetType: wire.target_type,
      targetId: wire.target_id,
      body: wire.body,
      authorId: wire.author_id,
      pinned: wire.pinned,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateNoteInput {
  readonly targetType: RecordTargetType
  readonly targetId: string
  readonly body: string
  readonly pinned?: boolean
}

export function createNoteBody(input: CreateNoteInput): Record<string, unknown> {
  return definedFields({
    target_type: input.targetType,
    target_id: input.targetId,
    body: input.body,
    pinned: input.pinned,
  })
}

/** The target never moves: re-filing a note under another record is a delete and a create. */
export interface NoteInput {
  readonly body?: string
  readonly pinned?: boolean
}

export function noteBody(input: NoteInput): Record<string, unknown> {
  return definedFields({ body: input.body, pinned: input.pinned })
}

import { z } from 'zod'

import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/handbook_pages`, the workspace's nested
 * markdown handbook.
 *
 * The response is flat: `parentId` and `sortOrder` are the tree, and the caller
 * rebuilds it. `sortOrder` positions a page among its siblings only, so it is
 * meaningless across the whole set and the list is not sorted by it.
 *
 * `updatedBy` is a workspace member id, not a user id, and is null when no
 * member was behind the write (a workspace API key). Resolving it to a name is
 * the caller's job, as with a note's author.
 */

/** Top-level pages are 0, so `MAX_DEPTH` of 4 allows five levels. Mirrors the server's cap. */
export const MAX_HANDBOOK_DEPTH = 4

export interface HandbookPage extends RecordTimestamps {
  readonly id: string
  readonly title: string
  /** The stable handle agent tasks name pages by. It does not follow the title. */
  readonly slug: string
  readonly parentId: string | null
  readonly sortOrder: number
  readonly body: string
  readonly updatedBy: string | null
}

export const handbookPageSchema: z.ZodType<HandbookPage, unknown> = z
  .object({
    id: idSchema,
    title: z.string(),
    slug: z.string(),
    parent_id: idSchema.nullable(),
    sort_order: z.number().int(),
    body: z.string(),
    updated_by: idSchema.nullable(),
    ...recordTimestamps,
  })
  .transform(
    (wire): HandbookPage => ({
      id: wire.id,
      title: wire.title,
      slug: wire.slug,
      parentId: wire.parent_id,
      sortOrder: wire.sort_order,
      body: wire.body,
      updatedBy: wire.updated_by,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreateHandbookPageInput {
  readonly title: string
  /** Absent means empty: a page is created before it is written. */
  readonly body?: string
  /** Absent means derived from the title, with a numeric suffix if that is taken. */
  readonly slug?: string
  /** Absent or null puts the page at the top level. */
  readonly parentId?: string | null
}

export function createHandbookPageBody(input: CreateHandbookPageInput): Record<string, unknown> {
  return definedFields({
    title: input.title,
    body: input.body,
    slug: input.slug,
    parent_id: input.parentId,
  })
}

/**
 * `parentId` and `sortOrder` are the move; the rest is the edit. A drag sends
 * both halves of the move together, because landing somewhere new is a parent
 * and a position at once.
 */
export interface HandbookPageInput {
  readonly title?: string
  readonly body?: string
  readonly slug?: string
  /** Null lifts the page to the top level. */
  readonly parentId?: string | null
  readonly sortOrder?: number
}

export function handbookPageBody(input: HandbookPageInput): Record<string, unknown> {
  return definedFields({
    title: input.title,
    body: input.body,
    slug: input.slug,
    parent_id: input.parentId,
    sort_order: input.sortOrder,
  })
}

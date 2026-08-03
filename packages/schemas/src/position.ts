import { z } from 'zod'

import { idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/**
 * Wire and write shapes for `/v1/positions`, the Person↔Company link that holds
 * the job title. Moving a link to a different person or company is a delete and
 * a create, which is why only the title is updatable.
 */

export interface Position extends RecordTimestamps {
  readonly id: string
  readonly personId: string
  readonly companyId: string
  readonly title: string
}

export const positionSchema: z.ZodType<Position, unknown> = z
  .object({
    id: idSchema,
    person_id: idSchema,
    company_id: idSchema,
    title: z.string(),
    ...recordTimestamps,
  })
  .transform(
    (wire): Position => ({
      id: wire.id,
      personId: wire.person_id,
      companyId: wire.company_id,
      title: wire.title,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreatePositionInput {
  readonly personId: string
  readonly companyId: string
  readonly title: string
}

export function createPositionBody(input: CreatePositionInput): Record<string, unknown> {
  return { person_id: input.personId, company_id: input.companyId, title: input.title }
}

export function updatePositionBody(title: string): Record<string, unknown> {
  return { title }
}

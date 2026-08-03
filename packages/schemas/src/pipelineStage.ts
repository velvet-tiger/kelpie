import { z } from 'zod'

import { PIPELINE_KINDS } from './values.ts'
import type { PipelineKind } from './values.ts'
import { definedFields, idSchema, recordTimestamps } from './wire.ts'
import type { RecordTimestamps } from './wire.ts'

/** Wire and write shapes for `/v1/pipeline_stages`. */

export interface PipelineStage extends RecordTimestamps {
  readonly id: string
  readonly kind: PipelineKind
  /** The stable import-alias id. Renaming the label never moves it. */
  readonly slug: string
  readonly label: string
  /** When false, hidden from the board's Open scope. */
  readonly open: boolean
  readonly sortOrder: number
}

export const pipelineStageSchema: z.ZodType<PipelineStage, unknown> = z
  .object({
    id: idSchema,
    kind: z.enum(PIPELINE_KINDS),
    slug: z.string(),
    label: z.string(),
    open: z.boolean(),
    sort_order: z.number().int(),
    ...recordTimestamps,
  })
  .transform(
    (wire): PipelineStage => ({
      id: wire.id,
      kind: wire.kind,
      slug: wire.slug,
      label: wire.label,
      open: wire.open,
      sortOrder: wire.sort_order,
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    }),
  )

export interface CreatePipelineStageInput {
  readonly kind: PipelineKind
  readonly label: string
  readonly open?: boolean
}

export function createPipelineStageBody(input: CreatePipelineStageInput): Record<string, unknown> {
  return definedFields({
    kind: input.kind,
    label: input.label,
    open: input.open,
  })
}

export interface UpdatePipelineStageInput {
  readonly label?: string
  readonly open?: boolean
  /** The stage's new 0-based position on its board. */
  readonly sortOrder?: number
}

export function updatePipelineStageBody(input: UpdatePipelineStageInput): Record<string, unknown> {
  return definedFields({
    label: input.label,
    open: input.open,
    sort_order: input.sortOrder,
  })
}

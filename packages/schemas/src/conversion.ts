import { z } from 'zod'

import { PIPELINE_KINDS } from './values.ts'
import type { PipelineKind } from './values.ts'
import { idSchema } from './wire.ts'

/** Where a pipeline record was converted to. Set once; read-only on the wire. */
export interface ConvertedTo {
  readonly targetType: PipelineKind
  readonly targetId: string
}

export const convertedToSchema: z.ZodType<ConvertedTo, unknown> = z
  .object({
    target_type: z.enum(PIPELINE_KINDS),
    target_id: idSchema,
  })
  .transform(
    (wire): ConvertedTo => ({
      targetType: wire.target_type,
      targetId: wire.target_id,
    }),
  )

export const convertedToWireSchema = z
  .object({
    target_type: z.enum(PIPELINE_KINDS),
    target_id: idSchema,
  })
  .nullable()

/** Body for `POST /v1/{pipeline}/:id/convert`. */
export interface ConvertPipelineRecordInput {
  readonly targetType: PipelineKind
  readonly stageId?: string | undefined
  readonly companyId?: string | undefined
  readonly kind?: string | undefined
  readonly name?: string | undefined
}

export const convertPipelineRecordBody = z.strictObject({
  target_type: z.enum(PIPELINE_KINDS),
  stage_id: idSchema.optional(),
  company_id: idSchema.optional(),
  kind: z.string().optional(),
  name: z.string().min(1).optional(),
})

/** Enquiry convert accepts an empty body and defaults the target to a deal. */
export const convertEnquiryBody = z.strictObject({
  target_type: z.enum(PIPELINE_KINDS).default('deal'),
  stage_id: idSchema.optional(),
  company_id: idSchema.optional(),
  kind: z.string().optional(),
  name: z.string().min(1).optional(),
})

export function convertPipelineRecordRequest(
  input: ConvertPipelineRecordInput,
): Record<string, unknown> {
  return {
    target_type: input.targetType,
    ...(input.stageId === undefined ? {} : { stage_id: input.stageId }),
    ...(input.companyId === undefined ? {} : { company_id: input.companyId }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
  }
}

/** Builds the wire `converted_to` object from stored columns. */
export function convertedToForWire(
  convertedTargetType: string | null,
  convertedTargetId: string | null,
): ConvertedTo | null {
  if (convertedTargetType === null || convertedTargetId === null) {
    return null
  }

  return {
    targetType: convertedTargetType as PipelineKind,
    targetId: convertedTargetId,
  }
}

export function convertedToResponse(
  convertedTargetType: string | null,
  convertedTargetId: string | null,
): Record<string, unknown> | null {
  const converted = convertedToForWire(convertedTargetType, convertedTargetId)

  if (converted === null) {
    return null
  }

  return {
    target_type: converted.targetType,
    target_id: converted.targetId,
  }
}

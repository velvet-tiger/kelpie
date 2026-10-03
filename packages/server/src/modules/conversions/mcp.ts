import { convertEnquiryBody, convertPipelineRecordBody, PIPELINE_KINDS } from '@kelpie/schemas'
import type { ApiKeyGranularScope, PipelineKind } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg } from '../crudTools.ts'
import type { ConversionsService } from './service.ts'
import { objectLabelFor } from './fieldMap.ts'
import { toConvertInput } from './routes.ts'
import { renderConvertedPipelineRecord } from './wire.ts'

const CONVERT_TOOL_RESOURCES: Readonly<Record<PipelineKind, string>> = {
  enquiry: 'enquiries',
  deal: 'deals',
  opportunity: 'opportunities',
  raise: 'raises',
  partnership: 'partnerships',
}

/** A conversion writes the source record, so it needs what `POST /v1/<source>/:id/convert` needs. */
const CONVERT_TOOL_SCOPES: Readonly<Record<PipelineKind, ApiKeyGranularScope>> = {
  enquiry: 'enquiries:write',
  deal: 'deals:write',
  opportunity: 'opportunities:write',
  raise: 'raises:write',
  partnership: 'partnerships:write',
}

export function registerPipelineConvertTool(
  mcp: McpToolRegistry,
  conversions: ConversionsService,
  sourceKind: PipelineKind,
): void {
  const bodySchema =
    sourceKind === 'enquiry'
      ? convertEnquiryBody
      : convertPipelineRecordBody

  mcp.tool({
    name: `${CONVERT_TOOL_RESOURCES[sourceKind]}_convert`,
    description:
      `Convert a ${objectLabelFor(sourceKind)} to another pipeline record type. ` +
      'Creates a new record, moves notes/activities/decisions/plans to it, copies ' +
      'linked people, and leaves the source in place with a conversion link. ' +
      `Target types: ${PIPELINE_KINDS.join(', ')}. 409 if already converted.`,
    scope: CONVERT_TOOL_SCOPES[sourceKind],
    inputSchema: bodySchema.and(z.strictObject({ id: idArg })),
    invoke: async (args, actor) => {
      const { id, ...body } = args
      const { targetKind, target, personIds } = await conversions.convert(
        actor,
        sourceKind,
        id,
        toConvertInput(body),
      )

      return renderConvertedPipelineRecord(targetKind, target, personIds)
    },
  })
}

/** Backward-compatible alias for agents that still call enquiries_convert_to_deal. */
export function registerEnquiryConvertToDealTool(
  mcp: McpToolRegistry,
  conversions: ConversionsService,
): void {
  mcp.tool({
    name: 'enquiries_convert_to_deal',
    description:
      'Convert an enquiry to a Deal. Same as enquiries_convert with target_type deal. ' +
      'Mirrors POST /v1/enquiries/{id}/convert.',
    scope: 'enquiries:write',
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => {
      const { targetKind, target, personIds } = await conversions.convert(actor, 'enquiry', id, {
        targetType: 'deal',
      })

      return renderConvertedPipelineRecord(targetKind, target, personIds)
    },
  })
}

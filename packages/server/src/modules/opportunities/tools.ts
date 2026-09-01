import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import type { ConversionsService } from '../conversions/index.ts'
import { registerPipelineConvertTool } from '../conversions/mcp.ts'
import { createBody, opportunityResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { OpportunitiesService } from './service.ts'

/** `opportunities_*`. Same schemas and mappers as `/v1/opportunities`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  kind: idSetArg.optional().describe('Kinds are free text, so a match here is exact.'),
  company_id: idSetArg.optional().describe('Only opportunities with these companies.'),
  stage_id: idSetArg.optional().describe('Only opportunities in these pipeline stages.'),
  person_id: idSetArg.optional().describe('Only opportunities any of these people are on.'),
})

export function registerOpportunitiesTools(
  mcp: McpToolRegistry,
  service: OpportunitiesService,
  conversions: ConversionsService,
): void {
  registerCrudTools(mcp, {
    resource: 'opportunities',
    subject: 'opportunity',
    about:
      'A non-sales chance: a grant, accelerator, tender, press or speaking slot. ' +
      'Not another word for a deal.',
    service,
    render: opportunityResponse,
    listArgs,
    toFilters: (args) => ({
      term: args.q,
      kinds: toSet(args.kind),
      companyIds: toSet(args.company_id),
      stageIds: toSet(args.stage_id),
      personIds: toSet(args.person_id),
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  registerPipelineConvertTool(mcp, conversions, 'opportunity')
}

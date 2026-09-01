import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import type { ConversionsService } from '../conversions/index.ts'
import { registerPipelineConvertTool } from '../conversions/mcp.ts'
import { createBody, dealResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { DealsService } from './service.ts'

/** `deals_*`. Same schemas and mappers as `/v1/deals`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  company_id: idSetArg.optional().describe('Only deals with these companies.'),
  stage_id: idSetArg.optional().describe('Only deals in these pipeline stages: one kanban column.'),
  person_id: idSetArg.optional().describe('Only deals one of these people is a contact on.'),
})

export function registerDealsTools(
  mcp: McpToolRegistry,
  service: DealsService,
  conversions: ConversionsService,
): void {
  registerCrudTools(mcp, {
    resource: 'deals',
    subject: 'deal',
    about:
      'A sales pipeline record. Move one by setting stage_id to a stage from ' +
      'pipeline_stages_list with kind deal.',
    service,
    render: dealResponse,
    listArgs,
    toFilters: (args) => ({
      term: args.q,
      companyIds: toSet(args.company_id),
      stageIds: toSet(args.stage_id),
      personIds: toSet(args.person_id),
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  registerPipelineConvertTool(mcp, conversions, 'deal')
}

import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import {
  idArg,
  idSetArg,
  listWindowShape,
  registerCrudTools,
  termArg,
  toSet,
} from '../crudTools.ts'
import { dealResponse } from '../deals/routes.ts'
import { createBody, enquiryResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { EnquiriesService } from './service.ts'

/** `enquiries_*`. Same schemas and mappers as `/v1/enquiries`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  source: idSetArg.optional().describe('Sources are free text, so a match here is exact.'),
  company_id: idSetArg.optional().describe('Only enquiries with these companies.'),
  stage_id: idSetArg.optional().describe('Only enquiries in these pipeline stages.'),
  person_id: idSetArg.optional().describe('Only enquiries any of these people are on.'),
})

export function registerEnquiriesTools(mcp: McpToolRegistry, service: EnquiriesService): void {
  registerCrudTools(mcp, {
    resource: 'enquiries',
    subject: 'enquiry',
    about:
      'An inbound enquiry: a top-of-funnel request that may become a Deal once qualified. ' +
      'Not itself a deal.',
    service,
    render: enquiryResponse,
    listArgs,
    toFilters: (args) => ({
      term: args.q,
      sources: toSet(args.source),
      companyIds: toSet(args.company_id),
      stageIds: toSet(args.stage_id),
      personIds: toSet(args.person_id),
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  mcp.tool({
    name: 'enquiries_convert_to_deal',
    description:
      'Convert an enquiry to a Deal. Copies name, company, owner and linked ' +
      'people to a new deal in the first open deal stage, moves the enquiry ' +
      'to its first closed stage, and records the link on the enquiry. 409 if ' +
      'the enquiry has already been converted; 422 if it has no company. ' +
      'Mirrors POST /v1/enquiries/{id}/convert.',
    inputSchema: z.strictObject({ id: idArg }),
    invoke: async ({ id }, actor) => {
      const { deal, personIds } = await service.convertToDeal(actor, id)
      const { workspaceId: _workspaceId, ...dealView } = deal

      return dealResponse({ ...dealView, personIds })
    },
  })
}

import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { createBody, partnershipResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { PartnershipsService } from './service.ts'

/** `partnerships_*`. Same schemas and mappers as `/v1/partnerships`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  kind: idSetArg.optional().describe('Kinds are free text, so a match here is exact.'),
  company_id: idSetArg.optional().describe('Only partnerships with these companies.'),
  stage_id: idSetArg.optional().describe('Only partnerships in these pipeline stages.'),
  person_id: idSetArg.optional().describe('Only partnerships one of these people is a contact on.'),
})

export function registerPartnershipsTools(mcp: McpToolRegistry, service: PartnershipsService): void {
  registerCrudTools(mcp, {
    resource: 'partnerships',
    subject: 'partnership',
    about:
      'An ongoing two-way relationship, including the standing relationship with an ' +
      'investor. There is no favour ledger.',
    service,
    render: partnershipResponse,
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
}

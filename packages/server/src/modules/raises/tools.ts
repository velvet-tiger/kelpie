import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { createBody, raiseResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { RaisesService } from './service.ts'

/** `raises_*`. Same schemas and mappers as `/v1/raises`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  company_id: idSetArg.optional().describe('Only raises with these firms.'),
  stage_id: idSetArg.optional().describe('Only raises in these pipeline stages.'),
  person_id: idSetArg.optional().describe('Only raises one of these people is key on.'),
})

export function registerRaisesTools(mcp: McpToolRegistry, service: RaisesService): void {
  registerCrudTools(mcp, {
    resource: 'raises',
    subject: 'raise',
    about:
      'One firm\'s progress through one funding round: thesis fit, check size, pass reason. ' +
      'The standing relationship with that firm is a partnership.',
    service,
    render: raiseResponse,
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
}

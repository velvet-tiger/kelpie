import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, toSet } from '../crudTools.ts'
import { createBody, positionResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { PositionsService } from './service.ts'

/** `positions_*`. Same schemas and mappers as `/v1/positions`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  person_id: idSetArg.optional().describe('Only the positions held by these people.'),
  company_id: idSetArg.optional().describe('Only the positions held at these companies.'),
})

export function registerPositionsTools(mcp: McpToolRegistry, service: PositionsService): void {
  registerCrudTools(mcp, {
    resource: 'positions',
    subject: 'position',
    about:
      'The link between a person and a company, and the only place a job title lives. ' +
      'One person may hold several.',
    service,
    render: positionResponse,
    listArgs,
    toFilters: (args) => ({ personIds: toSet(args.person_id), companyIds: toSet(args.company_id) }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

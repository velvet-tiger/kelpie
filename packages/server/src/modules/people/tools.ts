import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { createBody, personResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { PeopleService } from './service.ts'

/** `people_*`. Same schemas and mappers as `/v1/people`, so the two cannot drift. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  company_id: idSetArg
    .optional()
    .describe('Only people holding a position at one of these companies.'),
})

export function registerPeopleTools(mcp: McpToolRegistry, service: PeopleService): void {
  registerCrudTools(mcp, {
    resource: 'people',
    subject: 'person',
    about: 'Someone the workspace knows. A job title belongs to a position, never to the person.',
    service,
    render: personResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, companyIds: toSet(args.company_id) }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

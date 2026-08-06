import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { companyResponse, createBody, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { CompaniesService } from './service.ts'

/** `companies_*`. Same schemas and mappers as `/v1/companies`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  person_id: idSetArg
    .optional()
    .describe('Only companies where one of these people holds a position.'),
})

export function registerCompaniesTools(mcp: McpToolRegistry, service: CompaniesService): void {
  registerCrudTools(mcp, {
    resource: 'companies',
    subject: 'company',
    about: 'An organisation, with the stage, ICP fit and tech stack an agent qualifies against.',
    service,
    render: companyResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, personIds: toSet(args.person_id) }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

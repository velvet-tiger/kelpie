import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { createBody, handbookPageResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { HandbookService } from './service.ts'

/** `handbook_pages_*`. Same schemas and mappers as `/v1/handbook_pages`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg.describe('Free text over the title and the body. This is how you search the handbook.'),
  slug: idSetArg.optional().describe('Fetch pages by their stable slug rather than by id.'),
})

export function registerHandbookTools(mcp: McpToolRegistry, service: HandbookService): void {
  registerCrudTools(mcp, {
    resource: 'handbook_pages',
    subject: 'handbook page',
    about:
      'A markdown page of company knowledge: voice, ICP, how we sell, case studies. ' +
      'Read these before writing anything a customer will see.',
    service,
    render: handbookPageResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, slugs: toSet(args.slug) }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

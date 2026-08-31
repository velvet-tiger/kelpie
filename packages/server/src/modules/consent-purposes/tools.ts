import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, listWindowShape, registerCrudTools, termArg } from '../crudTools.ts'
import {
  createBody,
  consentPurposeResponse,
  toCreateInput,
  toUpdateInput,
  updateBody,
} from './routes.ts'
import type { ConsentPurposesService } from './service.ts'

/**
 * `consent_purposes_*`. Same schemas and mappers as `/v1/consent_purposes`, so
 * the REST surface and the MCP one cannot drift. Agents list purposes before
 * a person consent write so they know which slugs the workspace defines.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
})

export function registerConsentPurposesTools(
  mcp: McpToolRegistry,
  service: ConsentPurposesService,
): void {
  registerCrudTools(mcp, {
    resource: 'consent_purposes',
    subject: 'consent purpose',
    about:
      'A workspace-defined consent purpose. Read these before writing a person ' +
      'consent or setting a form/list/import purpose_id.',
    service,
    render: consentPurposeResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

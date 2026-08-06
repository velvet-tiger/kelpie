import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools, termArg, toSet } from '../crudTools.ts'
import { createBody, decisionResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { DecisionsService } from './service.ts'

/** `decisions_*`. Same schemas and mappers as `/v1/decisions`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  target_type: z.enum(RECORD_TARGET_TYPES).optional().describe('Decisions on this kind of record.'),
  target_id: idSetArg.optional().describe('The decisions on these records.'),
})

export function registerDecisionsTools(mcp: McpToolRegistry, service: DecisionsService): void {
  registerCrudTools(mcp, {
    resource: 'decisions',
    subject: 'decision',
    about:
      'A commitment this company has already made. Read the open ones before proposing ' +
      'anything; contradicting one is worse than saying nothing.',
    service,
    render: decisionResponse,
    listArgs,
    toFilters: (args) => ({
      term: args.q,
      targetType: args.target_type,
      targetIds: toSet(args.target_id),
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

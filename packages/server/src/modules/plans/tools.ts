import { PIPELINE_KINDS, PLAN_ITEM_STATUSES } from '@kelpie/schemas'
import { isoDateSchema } from '../../lib/dates.ts'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { enumSetArg, idArg, idSetArg, listWindowShape, registerCrudTools, toSet } from '../crudTools.ts'
import { createBody, planItemResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { PlansService } from './service.ts'

/** `plan_items_*`. Same schemas and mappers as `/v1/plan_items`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  target_type: z.enum(PIPELINE_KINDS).optional().describe('One pipeline\'s plan items.'),
  target_id: idSetArg.optional().describe('The plan items on these records.'),
  status: enumSetArg(PLAN_ITEM_STATUSES)
    .optional()
    .describe('Naming todo and in_progress together is how you ask for outstanding work.'),
  from: isoDateSchema.optional().describe('Inclusive lower bound, YYYY-MM-DD.'),
  to: isoDateSchema.optional().describe('Inclusive upper bound, YYYY-MM-DD.'),
})

export function registerPlansTools(mcp: McpToolRegistry, service: PlansService): void {
  registerCrudTools(mcp, {
    resource: 'plan_items',
    subject: 'plan item',
    about:
      'A dated, owned next step on a deal, opportunity, partnership or raise. ' +
      'Next steps live here, not in a summary field.',
    service,
    render: planItemResponse,
    listArgs,
    toFilters: (args) => ({
      targetType: args.target_type,
      targetIds: toSet(args.target_id),
      statuses: toSet(args.status),
      from: args.from,
      to: args.to,
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

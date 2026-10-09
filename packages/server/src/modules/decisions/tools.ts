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
  confirmed: z
    .boolean()
    .optional()
    .describe(
      'True for commitments only. False for proposals that no member has confirmed.',
    ),
})

export function registerDecisionsTools(mcp: McpToolRegistry, service: DecisionsService): void {
  registerCrudTools(mcp, {
    resource: 'decisions',
    subject: 'decision',
    scopes: { read: 'decisions:read', write: 'decisions:write' },
    about:
      'A commitment this company has already made. Read the open ones before proposing ' +
      'anything; contradicting one is worse than saying nothing. One with confirmed_at null ' +
      'is a proposal that no member has confirmed, whatever its origin: it is not a commitment. ' +
      'Only a signed-in member can confirm one, in the app. A decision you create is a ' +
      'proposal, with confirmed_at null, unless your connection has the decisions:commit ' +
      'scope. Tell the user that a member must confirm it in Kelpie. origin says what wrote ' +
      'it; when you change the body or the rationale it becomes agent, unless it is ai, ' +
      'which it stays. Without decisions:commit that change also makes a confirmed decision ' +
      'a proposal again.',
    service,
    render: decisionResponse,
    listArgs,
    toFilters: (args) => ({
      term: args.q,
      targetType: args.target_type,
      targetIds: toSet(args.target_id),
      confirmed: args.confirmed,
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

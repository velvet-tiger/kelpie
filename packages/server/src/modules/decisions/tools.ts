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
    scopes: { read: 'decisions:read', write: 'decisions:write', delete: 'decisions:delete' },
    about:
      'A commitment this company has already made. Read the open ones before proposing ' +
      'anything; contradicting one is worse than saying nothing. One with confirmed_at null ' +
      'is a proposal that no member has confirmed, whatever its origin: it is not a commitment. ' +
      'Only a signed-in member can confirm one, in the app. A decision you create is a ' +
      'proposal, with confirmed_at null, unless your connection has the decisions:commit ' +
      'scope. Tell the user that a member must confirm it in Kelpie. origin says what wrote ' +
      'it; when you change the body or the rationale it becomes agent, unless it is ai, ' +
      'which it stays. Without decisions:commit you cannot change the body or the rationale ' +
      'of a confirmed decision.',
    updateNote:
      'Without the decisions:commit scope, a change to the body or the rationale of a ' +
      'confirmed decision (confirmed_at set) is refused with forbidden, and nothing is ' +
      'written. Do not look for another way to change it: create a new decision with ' +
      'decisions_create, which is a proposal, and tell the user that a member must confirm ' +
      'it. You can still change due_at, decided_at and owner_id, and the text of a proposal.',
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

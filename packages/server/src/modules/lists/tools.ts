import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import {
  deleteResult,
  idArg,
  listWindowShape,
  pageResult,
  registerCrudTools,
  toListQuery,
} from '../crudTools.ts'
import {
  addMemberBody,
  createBody,
  listMemberResponse,
  listMembershipResponse,
  listResponse,
  toAddMemberInput,
  toCreateInput,
  toUpdateInput,
  updateBody,
} from './routes.ts'
import type { ListsService } from './service.ts'

/**
 * `lists_*`. Same schemas and mappers as `/v1/lists`, so the two cannot drift.
 *
 * The list-level five come from `registerCrudTools`; the three membership tools
 * are declared by hand because they hang off `/v1/lists/:id/members`, which does
 * not fit the by-id CRUD shape.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: z
    .string()
    .min(1)
    .optional()
    .describe('Free text. Matches list names.'),
  target_type: z
    .enum(RECORD_TARGET_TYPES)
    .optional()
    .describe('Only lists that hold this kind of record.'),
})

const membersListArgs = z.strictObject({
  ...listWindowShape,
  list_id: idArg.describe('The list whose members you want.'),
})

const addMemberArgs = addMemberBody.extend({
  list_id: idArg.describe('The list to add to. Its type must match target_type.'),
})

const removeMemberArgs = z.strictObject({
  list_id: idArg.describe('The list to remove from.'),
  id: idArg.describe('The membership id, from list_members_list.'),
})

const membershipsForArgs = z.strictObject({
  target_type: z.enum(RECORD_TARGET_TYPES).describe('The kind of record.'),
  target_id: idArg.describe('The record whose list memberships you want.'),
})

export function registerListsTools(mcp: McpToolRegistry, service: ListsService): void {
  registerCrudTools(mcp, {
    resource: 'lists',
    subject: 'list',
    about:
      'A named collection of records of one type, chosen when the list is created and fixed for its lifetime.',
    service,
    render: listResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, targetType: args.target_type }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  mcp.tool({
    name: 'list_members_list',
    description:
      'List the records on one list. Cursor paged. Mirrors GET /v1/lists/{id}/members.',
    inputSchema: membersListArgs,
    invoke: async (args, actor) =>
      pageResult(
        await service.listMembers(actor, { listId: args.list_id }, toListQuery(args)),
        listMemberResponse,
      ),
  })

  mcp.tool({
    name: 'list_members_add',
    description:
      'Add a record to a list. The record\'s type must match the list\'s. ' +
      'Mirrors POST /v1/lists/{id}/members.',
    inputSchema: addMemberArgs,
    invoke: async (args, actor) =>
      listMemberResponse(await service.addMember(actor, args.list_id, toAddMemberInput(args))),
  })

  mcp.tool({
    name: 'list_members_remove',
    description:
      'Remove a record from a list. Mirrors DELETE /v1/lists/{id}/members/{memberId}.',
    inputSchema: removeMemberArgs,
    invoke: async (args, actor) => {
      await service.removeMember(actor, args.list_id, args.id)

      return deleteResult(args.id)
    },
  })

  mcp.tool({
    name: 'list_memberships_for',
    description:
      'Which lists is this record on? Returns one row per membership, with the ' +
      'list joined in. Mirrors GET /v1/list-memberships.',
    inputSchema: membershipsForArgs,
    invoke: async (args, actor) => {
      const memberships = await service.membershipsFor(actor, args.target_type, args.target_id)

      return { data: memberships.map(listMembershipResponse), next_cursor: null }
    },
  })
}

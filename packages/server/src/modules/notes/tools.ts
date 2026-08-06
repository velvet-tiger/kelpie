import { RECORD_TARGET_TYPES } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, idSetArg, listWindowShape, registerCrudTools } from '../crudTools.ts'
import { createBody, noteResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { NotesService } from './service.ts'

/** `notes_*`. Same schemas and mappers as `/v1/notes`. */

/**
 * `target_type` and `target_id` are required, exactly as they are on the REST
 * list. A note list always names the records it is for; there is no "every note
 * in the workspace" question to ask.
 */
const listArgs = z.strictObject({
  ...listWindowShape,
  target_type: z.enum(RECORD_TARGET_TYPES).describe('The kind of record these notes are on.'),
  target_id: idSetArg.describe('The records to read notes from. One id, or a page of them.'),
  pinned: z
    .boolean()
    .optional()
    .describe('True for pinned notes only. Pinned notes carry the signal; prefer them.'),
})

export function registerNotesTools(mcp: McpToolRegistry, service: NotesService): void {
  registerCrudTools(mcp, {
    resource: 'notes',
    subject: 'note',
    about: 'Freeform text attached to any record. A pinned one is what somebody wanted read first.',
    service,
    render: noteResponse,
    listArgs,
    toFilters: (args) => ({
      targetType: args.target_type,
      // Not `toSet`, whose undefined case cannot happen here and would have to be
      // defaulted to an empty array that means the opposite of what it looks like.
      targetIds: typeof args.target_id === 'string' ? [args.target_id] : args.target_id,
      pinned: args.pinned,
    }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

import { PIPELINE_KINDS } from '@kelpie/schemas'
import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { deleteResult, idArg, listWindowShape, registerCrudTools } from '../crudTools.ts'
import { createBody, stageResponse, toCreateInput, toUpdateInput, updateBody } from './routes.ts'
import type { PipelineStagesService } from './service.ts'

/** `pipeline_stages_*`. Same schemas and mappers as `/v1/pipeline_stages`. */

const listArgs = z.strictObject({
  ...listWindowShape,
  kind: z.enum(PIPELINE_KINDS).optional().describe("One pipeline's stages. Absent lists every pipeline's."),
})

export function registerPipelineTools(mcp: McpToolRegistry, service: PipelineStagesService): void {
  registerCrudTools(mcp, {
    resource: 'pipeline_stages',
    subject: 'pipeline stage',
    about:
      'A column on one of the four kanban boards. Read these to find the stage_id to ' +
      'move a deal, opportunity, partnership or raise into.',
    service,
    render: stageResponse,
    listArgs,
    toFilters: (args) => ({ kind: args.kind }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,

    // The one resource whose delete takes more than an id: removing a stage that
    // still holds records has to say where they go, or it refuses.
    registerDelete: (registry) => {
      registry.tool({
        name: 'pipeline_stages_delete',
        description:
          'Delete a pipeline stage. A stage that still holds records refuses unless ' +
          'move_to names the stage they move to. Mirrors DELETE /v1/pipeline_stages/{id}.',
        inputSchema: z.strictObject({
          id: idArg,
          move_to: idArg.optional().describe('Where the records standing in this stage go.'),
        }),
        invoke: async ({ id, move_to: moveTo }, actor) => {
          await service.remove(actor, id, moveTo)

          return deleteResult(id)
        },
      })
    },
  })
}

import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, listWindowShape, registerCrudTools, termArg } from '../crudTools.ts'
import {
  createBody,
  customFieldDefinitionResponse,
  toCreateInput,
  toUpdateInput,
  updateBody,
} from './routes.ts'
import { CUSTOM_FIELD_OBJECT_TYPES } from './schema.ts'
import type { CustomFieldDefinitionsService } from './service.ts'

/**
 * `custom_fields_*`. Same schemas and mappers as `/v1/custom_fields`, so the
 * REST surface and the MCP one cannot drift.
 *
 * The record-side tools (`deals_update`, `people_update`, …) pick up
 * `custom_fields` automatically through `registerCrudTools` reusing each
 * module's route bodies — see the `custom_fields` field on those bodies. The
 * schema's `.describe()` tells an agent to list definitions first.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  object_type: z
    .enum(CUSTOM_FIELD_OBJECT_TYPES)
    .optional()
    .describe('Only definitions for this record type.'),
})

export function registerCustomFieldsTools(
  mcp: McpToolRegistry,
  service: CustomFieldDefinitionsService,
): void {
  registerCrudTools(mcp, {
    resource: 'custom_fields',
    subject: 'custom field',
    about:
      'A workspace-defined field on a record type. Read these before writing values in a ' +
      'record create or update: a value is only accepted if it matches a definition here.',
    service,
    render: customFieldDefinitionResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, objectType: args.object_type }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })
}

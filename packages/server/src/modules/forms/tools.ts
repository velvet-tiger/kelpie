import { z } from 'zod'

import type { McpToolRegistry } from '../../runtime/module.ts'
import { idArg, listWindowShape, pageResult, registerCrudTools, termArg, toListQuery } from '../crudTools.ts'
import {
  createBody,
  formResponse,
  formSubmissionResponse,
  toCreateInput,
  toUpdateInput,
  updateBody,
} from './routes.ts'
import { FORM_STATUSES } from './schema.ts'
import type { FormsService } from './service.ts'

/**
 * `forms_*` and `form_submissions_list`, mirroring form management.
 *
 * No submit tool and no embed tool. Public submit is HTTP-only for browser
 * embeds, and an agent that wants to record an inbound contact creates the Person
 * with the ordinary CRM tools. The embed snippet is built from the origin the
 * request arrived on, which a tool call does not have.
 */

const listArgs = z.strictObject({
  ...listWindowShape,
  q: termArg,
  status: z.enum(FORM_STATUSES).optional().describe('active or paused.'),
})

const submissionListArgs = z.strictObject({
  ...listWindowShape,
  form_id: idArg.describe('The form whose submissions to read.'),
})

export function registerFormsTools(mcp: McpToolRegistry, service: FormsService): void {
  registerCrudTools(mcp, {
    resource: 'forms',
    subject: 'form',
    about:
      'An embeddable inbound form. A submission upserts a person, a company and a ' +
      'position, and optionally opens a deal.',
    service,
    render: formResponse,
    listArgs,
    toFilters: (args) => ({ term: args.q, status: args.status }),
    createArgs: createBody,
    toCreateInput,
    updateArgs: updateBody.extend({ id: idArg }),
    toUpdateInput,
  })

  mcp.tool({
    name: 'forms_regenerate_slug',
    description:
      "Replace a form's slug with a new random one. This changes the form's public " +
      'URLs, so every website that embeds the form stops working until it gets the ' +
      'new snippet. Mirrors POST /v1/forms/{id}/regenerate-slug.',
    inputSchema: z.strictObject({ id: idArg.describe('The form whose slug to replace.') }),
    invoke: async (args, actor) => formResponse(await service.regenerateSlug(actor, args.id)),
  })

  mcp.tool({
    name: 'form_submissions_list',
    description:
      'List what people submitted through one form, newest first. Cursor paged. ' +
      'Mirrors GET /v1/forms/{id}/submissions.',
    inputSchema: submissionListArgs,
    invoke: async (args, actor) =>
      pageResult(
        await service.listSubmissions(actor, args.form_id, toListQuery(args)),
        formSubmissionResponse,
      ),
  })
}
